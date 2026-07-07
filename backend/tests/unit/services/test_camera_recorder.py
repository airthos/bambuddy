"""Unit tests for the Sentry-mode recorder (camera_recorder.py).

Uses the real MjpegBroadcaster (camera_fanout.py) with a fake chamber-stream
generator standing in for the real printer socket — same style as
test_camera_fanout.py. No real printer, no real ffmpeg, no real network I/O.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.api.routes import camera as camera_routes
from backend.app.core.config import settings as app_settings
from backend.app.models.camera_recording import CameraRecordingFrame, CameraRecordingSession
from backend.app.models.settings import Settings
from backend.app.services import camera_fanout, camera_hls, camera_recorder
from backend.app.services.printer_manager import printer_manager

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
async def recorder_session_maker(monkeypatch, test_engine, tmp_path):
    """Point camera_recorder's module-level DB access and recordings dir at
    per-test isolated resources, so tests never touch the real project data
    directory or a shared DB. Also handed to tests that need to poll DB state
    written by a background task — via a *fresh* session per poll, not
    db_session's own, to avoid identity-map/expiry footguns (see
    _wait_for_status below).
    """
    test_async_session = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr("backend.app.core.database.async_session", test_async_session)
    monkeypatch.setattr(app_settings, "base_dir", tmp_path)

    # HLS encoding (camera_hls.py) has its own dedicated test file that mocks
    # the ffmpeg subprocess call directly. Here it's a no-op so these
    # recorder-pipeline tests don't spawn real ffmpeg processes (not
    # installed on every dev machine) or leak background tasks across tests.
    async def _noop_live_loop(session):
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            pass

    async def _noop_finalize(archive_id, printer_id, framelog_path):
        pass

    monkeypatch.setattr(camera_hls, "live_loop", _noop_live_loop)
    monkeypatch.setattr(camera_hls, "finalize", _noop_finalize)

    return test_async_session


async def _cancel_leftover_sessions():
    """`.clear()`-ing _active_sessions removes dict entries but does NOT cancel
    the pump/watchdog asyncio Tasks a leftover RecordingSession still
    references — those keep running against a test_engine that's about to be
    torn down by the next test, causing "no such table" errors that surface
    misattributed to whatever test happens to be running when they fire.
    Explicitly cancel and await them first.
    """
    sessions = list(camera_recorder._active_sessions.values())
    camera_recorder._active_sessions.clear()
    for session in sessions:
        for task in (session.watchdog_task, session.pump_task, session.hls_task):
            if task is not None and not task.done():
                task.cancel()
        for task in (session.watchdog_task, session.pump_task, session.hls_task):
            if task is not None:
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass


@pytest.fixture(autouse=True)
async def _clean_registry():
    await _cancel_leftover_sessions()
    await camera_fanout.shutdown_all_broadcasters()
    yield
    await _cancel_leftover_sessions()
    await camera_fanout.shutdown_all_broadcasters()


async def _set_sentry_enabled(db_session, enabled: bool) -> None:
    db_session.add(Settings(key="sentry_enabled", value="true" if enabled else "false"))
    await db_session.commit()


def _fake_chamber_stream(frames: list[bytes], *, keep_alive: bool = True):
    """Matches generate_chamber_mjpeg_stream's signature; yields well-formed
    multipart chunks the recorder's _extract_jpeg() can parse, then idles."""

    async def _fake(*, ip_address, access_code, model, fps, stream_id=None, disconnect_event=None, printer_id=None):
        for f in frames:
            if disconnect_event is not None and disconnect_event.is_set():
                return
            yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(f)).encode() + b"\r\n\r\n" + f + b"\r\n"
            await asyncio.sleep(0.005)
        while keep_alive and (disconnect_event is None or not disconnect_event.is_set()):
            await asyncio.sleep(0.01)

    return _fake


async def _wait_until(predicate, timeout: float = 2.0, interval: float = 0.02):
    async def _poll():
        while not predicate():
            await asyncio.sleep(interval)

    await asyncio.wait_for(_poll(), timeout=timeout)


async def _wait_for_status(session_maker, archive_id: int, expected: str, timeout: float = 2.0, interval: float = 0.02):
    """Poll the DB row's status directly rather than _active_sessions membership —
    _end_session() pops the in-memory session BEFORE it awaits the pump-task
    cancellation and commits the final status, so checking the dict alone
    races with the DB write actually landing.

    Uses a fresh session per poll (not a long-lived fixture session) so there's
    no identity map to go stale and no risk of an expired ORM attribute
    triggering an implicit (sync-context) reload under async SQLAlchemy.
    """

    async def _poll():
        while True:
            async with session_maker() as db:
                result = await db.execute(select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive_id))
                row = result.scalar_one_or_none()
                if row is not None and row.status == expected:
                    return row
            await asyncio.sleep(interval)

    return await asyncio.wait_for(_poll(), timeout=timeout)


# ---------------------------------------------------------------------------
# start_session
# ---------------------------------------------------------------------------


async def test_start_session_returns_false_when_disabled(db_session, printer_factory, archive_factory):
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")

    started = await camera_recorder.start_session(printer, printer.id, archive.id)

    assert started is False
    assert archive.id not in camera_recorder._active_sessions


async def test_start_session_rejects_rtsp_model(db_session, printer_factory, archive_factory):
    await _set_sentry_enabled(db_session, True)
    printer = await printer_factory(model="X1C")  # RTSP model — not yet supported
    archive = await archive_factory(printer.id, status="printing")

    started = await camera_recorder.start_session(printer, printer.id, archive.id)

    assert started is False
    assert archive.id not in camera_recorder._active_sessions


async def test_start_session_creates_recording_and_db_row(monkeypatch, db_session, printer_factory, archive_factory, recorder_session_maker):
    await _set_sentry_enabled(db_session, True)
    monkeypatch.setattr(camera_routes, "generate_chamber_mjpeg_stream", _fake_chamber_stream([b"f1", b"f2", b"f3"]))
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")

    started = await camera_recorder.start_session(printer, printer.id, archive.id)
    assert started is True
    assert archive.id in camera_recorder._active_sessions

    result = await db_session.execute(select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive.id))
    row = result.scalar_one()
    assert row.status == "recording"
    assert row.printer_id == printer.id

    # Cleanup: end the session (releases the pinned broadcaster subscriber, cancels tasks).
    await camera_recorder.stop_session(archive.id, tail_seconds=0)
    await _wait_for_status(recorder_session_maker, archive.id, "completed")


async def test_start_session_idempotent_per_archive(monkeypatch, db_session, printer_factory, archive_factory, recorder_session_maker):
    await _set_sentry_enabled(db_session, True)
    monkeypatch.setattr(camera_routes, "generate_chamber_mjpeg_stream", _fake_chamber_stream([b"f1"]))
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")

    first = await camera_recorder.start_session(printer, printer.id, archive.id)
    second = await camera_recorder.start_session(printer, printer.id, archive.id)
    assert first is True
    assert second is False

    result = await db_session.execute(select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive.id))
    rows = result.scalars().all()
    assert len(rows) == 1

    await camera_recorder.stop_session(archive.id, tail_seconds=0)
    await _wait_for_status(recorder_session_maker, archive.id, "completed")


# ---------------------------------------------------------------------------
# Frame pump + stop_session
# ---------------------------------------------------------------------------


async def test_pump_writes_frames_and_completes_on_stop(monkeypatch, db_session, printer_factory, archive_factory, recorder_session_maker):
    await _set_sentry_enabled(db_session, True)
    # keep_alive=False: let the fake upstream end naturally after 3 frames.
    # Cap reconnect attempts to 0 so that natural end terminates the pump
    # outright instead of replaying the same 3 frames via the retry loop —
    # we want one deterministic pass here; the retry loop itself has its own
    # dedicated tests below.
    monkeypatch.setattr(camera_recorder, "_MAX_RECONNECT_ATTEMPTS", 0)
    monkeypatch.setattr(
        camera_routes, "generate_chamber_mjpeg_stream", _fake_chamber_stream([b"AAA", b"BB", b"C"], keep_alive=False)
    )
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")

    await camera_recorder.start_session(printer, printer.id, archive.id)
    session = camera_recorder._active_sessions[archive.id]
    await _wait_until(lambda: session.pump_task.done())

    await camera_recorder.stop_session(archive.id, tail_seconds=0)
    row = await _wait_for_status(recorder_session_maker, archive.id, "completed")

    assert row.frame_count == 3
    assert row.size_bytes == len(b"AAA") + len(b"BB") + len(b"C")
    assert row.stopped_at is not None

    frame_result = await db_session.execute(
        select(CameraRecordingFrame).where(CameraRecordingFrame.archive_id == archive.id).order_by(CameraRecordingFrame.seq)
    )
    frames = frame_result.scalars().all()
    assert [f.seq for f in frames] == [0, 1, 2]

    # Verify the framelog file actually contains the JPEG bytes at the indexed offsets.
    # (os.pread is POSIX-only; production runs on Linux but this test suite
    # also needs to pass on a Windows dev machine, so seek+read instead.)
    recovered = []
    with open(row.file_path, "rb") as f:
        for frame in frames:
            f.seek(frame.offset)
            recovered.append(f.read(frame.length))
    assert recovered == [b"AAA", b"BB", b"C"]


async def test_handle_print_complete_noops_without_active_session():
    # No session active for this archive_id — must not raise.
    await camera_recorder.handle_print_complete(999999)
    await camera_recorder.handle_print_complete(None)


# ---------------------------------------------------------------------------
# Watchdog
# ---------------------------------------------------------------------------


async def test_watchdog_orphans_session_if_running_never_reached(monkeypatch, db_session, printer_factory, archive_factory, recorder_session_maker):
    await _set_sentry_enabled(db_session, True)
    monkeypatch.setattr(camera_routes, "generate_chamber_mjpeg_stream", _fake_chamber_stream([b"f1"]))
    monkeypatch.setattr(camera_recorder, "_RUNNING_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(camera_recorder, "_RUNNING_POLL_SECONDS", 0.01)
    monkeypatch.setattr(printer_manager, "get_status", lambda pid: None)  # never reaches RUNNING
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")

    await camera_recorder.start_session(printer, printer.id, archive.id)
    await _wait_for_status(recorder_session_maker, archive.id, "orphaned")


async def test_watchdog_does_not_orphan_when_running_reached(monkeypatch, db_session, printer_factory, archive_factory, recorder_session_maker):
    """Regression test for a real production bug: the watchdog checked
    ``status.gcode_state`` but PrinterState's field is actually named
    ``state`` — so the getattr() default of None meant reached_running was
    NEVER True, and every single recording got killed as "orphaned" once
    _RUNNING_TIMEOUT_SECONDS elapsed, regardless of what the printer was
    actually doing. Uses the real PrinterState field name here so a
    regression back to the wrong attribute name fails this test.
    """
    await _set_sentry_enabled(db_session, True)
    monkeypatch.setattr(camera_routes, "generate_chamber_mjpeg_stream", _fake_chamber_stream([b"f1"]))
    monkeypatch.setattr(camera_recorder, "_RUNNING_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(camera_recorder, "_RUNNING_POLL_SECONDS", 0.01)
    monkeypatch.setattr(camera_recorder, "_DISCONNECT_POLL_SECONDS", 0.01)

    class _RunningState:
        state = "RUNNING"

    monkeypatch.setattr(printer_manager, "get_status", lambda pid: _RunningState())
    monkeypatch.setattr(printer_manager, "is_connected", lambda pid: True)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")

    await camera_recorder.start_session(printer, printer.id, archive.id)
    await asyncio.sleep(0.2)  # give the watchdog time to have wrongly orphaned it, if the bug regresses
    assert archive.id in camera_recorder._active_sessions
    await camera_recorder.stop_session(archive.id, tail_seconds=0)
    await _wait_for_status(recorder_session_maker, archive.id, "completed")


async def test_watchdog_orphans_session_on_prolonged_disconnect(monkeypatch, db_session, printer_factory, archive_factory, recorder_session_maker):
    await _set_sentry_enabled(db_session, True)
    monkeypatch.setattr(camera_routes, "generate_chamber_mjpeg_stream", _fake_chamber_stream([b"f1"]))
    monkeypatch.setattr(camera_recorder, "_DISCONNECT_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(camera_recorder, "_DISCONNECT_POLL_SECONDS", 0.01)

    class _RunningState:
        state = "RUNNING"

    monkeypatch.setattr(printer_manager, "get_status", lambda pid: _RunningState())
    monkeypatch.setattr(printer_manager, "is_connected", lambda pid: False)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")

    await camera_recorder.start_session(printer, printer.id, archive.id)
    await _wait_for_status(recorder_session_maker, archive.id, "orphaned")


# ---------------------------------------------------------------------------
# reconcile_on_startup
# ---------------------------------------------------------------------------


async def test_reconcile_resumes_session_without_duplicate_row(
    monkeypatch, db_session, printer_factory, archive_factory, tmp_path, recorder_session_maker
):
    """Regression test: reconcile_on_startup must pass resume_row= so
    start_session() doesn't try to INSERT a row that already exists (would
    raise a UNIQUE constraint violation on archive_id)."""
    monkeypatch.setattr(camera_routes, "generate_chamber_mjpeg_stream", _fake_chamber_stream([b"f1"]))
    monkeypatch.setattr(printer_manager, "is_connected", lambda pid: True)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")
    printer_id, archive_id = printer.id, archive.id
    monkeypatch.setattr(printer_manager, "get_printer", lambda pid: printer if pid == printer_id else None)

    stale_row = CameraRecordingSession(
        archive_id=archive_id,
        printer_id=printer_id,
        status="recording",
        file_path=str(tmp_path / "resumed.framelog"),
        frame_count=42,
        size_bytes=4200,
    )
    db_session.add(stale_row)
    await db_session.commit()

    await camera_recorder.reconcile_on_startup()

    assert archive_id in camera_recorder._active_sessions
    session = camera_recorder._active_sessions[archive_id]
    # >= 42, not == : the resumed session's pump may have already processed
    # the fake stream's one frame by the time this assertion runs. The point
    # is it resumed from 42 (the stale row), not reset to 0.
    assert session.frame_count >= 42
    assert session.size_bytes >= 4200

    # reconcile_on_startup() commits through a *different* session than
    # db_session's own, so re-query through a fresh session (not db_session)
    # to avoid its stale identity-mapped copy of the row (expire_on_commit=False).
    async with recorder_session_maker() as fresh_db:
        result = await fresh_db.execute(select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive_id))
        rows = result.scalars().all()
        assert len(rows) == 1  # no duplicate row created


async def test_reconcile_does_not_orphan_session_already_started_by_print_callback(
    monkeypatch, db_session, printer_factory, archive_factory, tmp_path, recorder_session_maker
):
    """Regression test for a real production bug: on a backend restart, an
    on_print_start/on_print_running_observed callback can win the race and
    bring a session back up (via start_session's own resume-terminal-row
    logic) before reconcile_on_startup gets to the same archive_id. Since
    start_session() is idempotent, its own call from reconcile_on_startup
    then returns False just because the session is already active — that
    used to be misread as "resume failed" and reconcile would orphan a
    perfectly live, actively-recording session out from under it.
    """
    monkeypatch.setattr(camera_routes, "generate_chamber_mjpeg_stream", _fake_chamber_stream([b"f1"]))
    monkeypatch.setattr(printer_manager, "is_connected", lambda pid: True)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")
    printer_id, archive_id = printer.id, archive.id
    monkeypatch.setattr(printer_manager, "get_printer", lambda pid: printer if pid == printer_id else None)

    stale_row = CameraRecordingSession(
        archive_id=archive_id,
        printer_id=printer_id,
        status="recording",
        file_path=str(tmp_path / "already-started.framelog"),
        frame_count=10,
        size_bytes=1000,
    )
    db_session.add(stale_row)
    await db_session.commit()

    # Simulate the print-start callback winning the race: a live in-memory
    # session already exists for this archive_id by the time reconcile runs.
    winning_session = camera_recorder.RecordingSession(
        printer_id=printer_id,
        archive_id=archive_id,
        file_path=tmp_path / "already-started.framelog",
        queue=asyncio.Queue(),
        broadcaster=None,
    )
    camera_recorder._active_sessions[archive_id] = winning_session
    try:
        await camera_recorder.reconcile_on_startup()

        async with recorder_session_maker() as fresh_db:
            result = await fresh_db.execute(
                select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive_id)
            )
            row = result.scalar_one()
            assert row.status == "recording"  # not orphaned
    finally:
        camera_recorder._active_sessions.pop(archive_id, None)


async def test_reconcile_orphans_session_when_printer_offline(
    monkeypatch, db_session, printer_factory, archive_factory, tmp_path, recorder_session_maker
):
    monkeypatch.setattr(printer_manager, "is_connected", lambda pid: False)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")
    printer_id, archive_id = printer.id, archive.id

    stale_row = CameraRecordingSession(
        archive_id=archive_id,
        printer_id=printer_id,
        status="recording",
        file_path=str(tmp_path / "resumed.framelog"),
    )
    db_session.add(stale_row)
    await db_session.commit()

    await camera_recorder.reconcile_on_startup()

    assert archive_id not in camera_recorder._active_sessions
    async with recorder_session_maker() as fresh_db:
        result = await fresh_db.execute(select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive_id))
        row = result.scalar_one()
        assert row.status == "orphaned"
        assert row.stopped_at is not None


async def test_reconcile_orphans_session_when_archive_no_longer_printing(
    monkeypatch, db_session, printer_factory, archive_factory, tmp_path, recorder_session_maker
):
    monkeypatch.setattr(printer_manager, "is_connected", lambda pid: True)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="completed")  # job finished, not "printing"
    printer_id, archive_id = printer.id, archive.id

    stale_row = CameraRecordingSession(
        archive_id=archive_id,
        printer_id=printer_id,
        status="recording",
        file_path=str(tmp_path / "resumed.framelog"),
    )
    db_session.add(stale_row)
    await db_session.commit()

    await camera_recorder.reconcile_on_startup()

    assert archive_id not in camera_recorder._active_sessions
    async with recorder_session_maker() as fresh_db:
        result = await fresh_db.execute(select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive_id))
        row = result.scalar_one()
        assert row.status == "orphaned"
