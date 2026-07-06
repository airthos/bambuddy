"""Sentry mode: per-print-job camera recording.

A recording session is keyed 1:1 by ``print_archives.id`` and spans
``[dispatch, completion + post-roll]`` — not 24/7 (see docs/airtho/). The
recorder subscribes to the *same* MjpegBroadcaster (camera_fanout.py) that
live camera viewers use, as a **pinned** subscriber (#sentry-mode), so:

- it never opens a second connection to the printer (most Bambu printers
  allow exactly one concurrent camera connection), and
- an unrelated viewer's "stop camera" call (routes/camera.py::stop_camera_stream,
  which today force-shuts-down the whole broadcaster) can't kill an
  in-progress recording — see the pinned-subscriber guard in camera_fanout.py.

True pre-roll (frames from *before* the printer's camera connection opens)
isn't physically possible without holding every printer's camera connection
open 24/7, which defeats the point of event-triggered recording — nothing is
watching an idle printer between jobs, so there's nothing to buffer from.
`sentry_pre_roll_minutes` is honored on a best-effort basis: recording starts
as early as the call sites below can trigger it (print-start / restart-
recovery), not literally N minutes before the print begins.

The watchdog in this module is not optional polish: without it, a printer
that goes offline mid-print (a known, unrelated, unfixed bug — see
docs/airtho/known-issues.md) would leave a pinned subscriber wedged forever,
permanently blocking camera access — live view included — for that printer.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from sqlalchemy import select

from backend.app.core import database as _database
from backend.app.core.config import settings as app_settings
from backend.app.models.archive import PrintArchive
from backend.app.models.camera_recording import CameraRecordingFrame, CameraRecordingSession

logger = logging.getLogger(__name__)

RECORDINGS_DIR_NAME = "camera_recordings"
_FRAME_INDEX_BATCH = 10
_RUNNING_TIMEOUT_SECONDS = 120  # give up if the print never actually starts
_ACTIVE_GCODE_STATES = {"RUNNING", "PREPARE"}  # PREPARE covers bed leveling/calibration, which can outlast the timeout
_DISCONNECT_TIMEOUT_SECONDS = 600  # close the session if the printer's unreachable this long mid-print
_RUNNING_POLL_SECONDS = 3
_DISCONNECT_POLL_SECONDS = 5
_CONTENT_LENGTH_RE = re.compile(rb"Content-Length:\s*(\d+)", re.IGNORECASE)


@dataclass
class RecordingSession:
    printer_id: int
    archive_id: int
    file_path: Path
    queue: "asyncio.Queue[bytes]" = field(repr=False)
    broadcaster: object = field(repr=False)  # camera_fanout.MjpegBroadcaster
    frame_count: int = 0
    size_bytes: int = 0
    pump_task: asyncio.Task | None = None
    watchdog_task: asyncio.Task | None = None
    stopping: bool = False


# Active sessions, keyed by archive_id — mirrors layer_timelapse.py's
# module-level _active_sessions dict pattern.
_active_sessions: dict[int, RecordingSession] = {}


def is_recording(archive_id: int) -> bool:
    return archive_id in _active_sessions


def _extract_jpeg(chunk: bytes) -> bytes | None:
    """Strip the multipart/x-mixed-replace wrapper the broadcaster hands
    subscribers (see routes/camera.py's generate_*_mjpeg_stream) back down
    to a raw JPEG. Returns None for non-frame chunks (e.g. the "camera
    connection failed" text/plain error chunk, which has no Content-Length).
    """
    sep = chunk.find(b"\r\n\r\n")
    if sep == -1:
        return None
    header, body = chunk[:sep], chunk[sep + 4 :]
    match = _CONTENT_LENGTH_RE.search(header)
    if not match:
        return None
    length = int(match.group(1))
    if len(body) < length:
        return None
    return body[:length]


async def _get_sentry_config(db) -> tuple[bool, int, int, int]:
    from backend.app.api.routes.settings import _build_settings_response

    cfg = await _build_settings_response(db)
    return cfg.sentry_enabled, cfg.sentry_retention_days, cfg.sentry_pre_roll_minutes, cfg.sentry_post_roll_seconds


async def start_session(
    printer, printer_id: int, archive_id: int, *, resume_row: CameraRecordingSession | None = None
) -> bool:
    """Start a Sentry recording for archive_id, if enabled. Idempotent per archive_id.

    ``resume_row`` is set only by reconcile_on_startup() when resuming a
    session whose DB row already exists from a prior process — skips the
    insert and re-seeds frame_count/size_bytes instead of starting at 0.

    When called without resume_row, a leftover terminal-status row for the
    same archive_id (from a previous watchdog-killed or crash-orphaned attempt
    on the same still-printing job) is also revived rather than inserted over
    — the archive_id UNIQUE constraint would otherwise reject the insert and
    the job would silently get no recording at all.
    """
    if archive_id in _active_sessions:
        return False

    if resume_row is None:
        async with _database.async_session() as db:
            sentry_enabled, _, _, _ = await _get_sentry_config(db)
            if not sentry_enabled:
                return False
            # A row can already exist for this archive_id if an earlier attempt
            # for the same still-printing job ended (e.g. the old RUNNING-timeout
            # watchdog bug, or a backend restart mid-print before that row was
            # reconciled). Reuse it instead of inserting — the UNIQUE constraint
            # on archive_id would otherwise reject a fresh row outright and the
            # job would silently get no recording at all.
            existing = await db.execute(
                select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive_id)
            )
            existing_row = existing.scalar_one_or_none()
            if existing_row is not None:
                if existing_row.status == "recording":
                    return False  # a live row with no in-memory session is reconcile_on_startup's job, not ours
                existing_row.status = "recording"
                existing_row.stopped_at = None
                await db.commit()
                await db.refresh(existing_row)
                resume_row = existing_row
    # else: resuming a session that was already recording before a restart —
    # finish it out regardless of the current sentry_enabled value, same as
    # any other in-flight operation isn't aborted by a settings change.

    from backend.app.services.camera import is_chamber_image_model

    if not is_chamber_image_model(printer.model):
        # RTSP models (X1/H2/P2) aren't wired up yet — every printer in this
        # farm is P1S (chamber-image protocol). Extending to RTSP would need
        # its own generator wired in here the same way.
        logger.info(
            "Sentry: skipping archive %s on printer %s — only chamber-image (P1/A1) models are supported so far",
            archive_id,
            printer_id,
        )
        return False

    from backend.app.api.routes.camera import generate_chamber_mjpeg_stream
    from backend.app.services.camera_fanout import get_or_create_broadcaster

    fanout_key = f"printer-{printer_id}"
    upstream_stream_id = f"{printer_id}-fanout"

    def _factory(disconnect_event: asyncio.Event):
        return generate_chamber_mjpeg_stream(
            ip_address=printer.ip_address,
            access_code=printer.access_code,
            model=printer.model,
            fps=5,
            stream_id=upstream_stream_id,
            disconnect_event=disconnect_event,
            printer_id=printer_id,
        )

    broadcaster = await get_or_create_broadcaster(fanout_key, _factory)
    try:
        queue = await broadcaster.subscribe(pinned=True)
    except RuntimeError:
        # Same race the live-viewer route guards against: the broadcaster
        # flipped to stopped between lookup and subscribe. Retry once.
        broadcaster = await get_or_create_broadcaster(fanout_key, _factory)
        queue = await broadcaster.subscribe(pinned=True)

    if resume_row is not None:
        file_path = Path(resume_row.file_path)
        file_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        recordings_dir = Path(app_settings.base_dir) / RECORDINGS_DIR_NAME / str(printer_id)
        recordings_dir.mkdir(parents=True, exist_ok=True)
        file_path = recordings_dir / f"{archive_id}.framelog"

    session = RecordingSession(
        printer_id=printer_id,
        archive_id=archive_id,
        file_path=file_path,
        queue=queue,
        broadcaster=broadcaster,
        frame_count=resume_row.frame_count if resume_row is not None else 0,
        size_bytes=resume_row.size_bytes if resume_row is not None else 0,
    )
    _active_sessions[archive_id] = session

    if resume_row is None:
        async with _database.async_session() as db:
            db.add(
                CameraRecordingSession(
                    archive_id=archive_id,
                    printer_id=printer_id,
                    status="recording",
                    file_path=str(file_path),
                )
            )
            await db.commit()

    session.pump_task = asyncio.create_task(_pump_session(session), name=f"sentry-pump-{archive_id}")
    session.watchdog_task = asyncio.create_task(
        _watchdog(session, printer_id, archive_id), name=f"sentry-watchdog-{archive_id}"
    )
    logger.info("Sentry: started recording for archive %s (printer %s)", archive_id, printer_id)
    return True


async def stop_session(archive_id: int, tail_seconds: int) -> None:
    """Schedule the end of a recording, tail_seconds from now. Returns immediately —
    the actual stop happens in a background task so callers (on_print_complete)
    never block on the post-roll wait.
    """
    session = _active_sessions.get(archive_id)
    if session is None or session.stopping:
        return
    session.stopping = True
    asyncio.create_task(_stop_after_tail(session, tail_seconds), name=f"sentry-stop-{archive_id}")


async def handle_print_complete(archive_id: int | None) -> None:
    """Convenience wrapper for on_print_complete — no-ops if no session is
    active for archive_id (covers "Sentry was disabled", "not a chamber-image
    printer", "archive_id couldn't be resolved", all in one no-op check).
    Fires the same +post-roll tail regardless of completed/failed/cancelled —
    on_print_complete has already unified those into one callback by the time
    this runs (see bambu_mqtt.py's should_trigger_completion / "Fix 1").
    """
    if archive_id is None or archive_id not in _active_sessions:
        return
    async with _database.async_session() as db:
        _, _, _, post_roll_seconds = await _get_sentry_config(db)
    await stop_session(archive_id, post_roll_seconds)


async def _stop_after_tail(session: RecordingSession, tail_seconds: int) -> None:
    try:
        await asyncio.sleep(max(0, tail_seconds))
    except asyncio.CancelledError:
        return
    await _end_session(session, status="completed")


async def _end_session(session: RecordingSession, status: str) -> None:
    _active_sessions.pop(session.archive_id, None)

    if session.watchdog_task is not None:
        session.watchdog_task.cancel()
    if session.pump_task is not None:
        session.pump_task.cancel()
        await session.pump_task  # the pump swallows its own CancelledError

    try:
        await session.broadcaster.unsubscribe(session.queue)
    except Exception:
        logger.exception("Sentry: error unsubscribing archive %s", session.archive_id)

    async with _database.async_session() as db:
        result = await db.execute(
            select(CameraRecordingSession).where(CameraRecordingSession.archive_id == session.archive_id)
        )
        row = result.scalar_one_or_none()
        if row is not None:
            row.status = status
            row.stopped_at = datetime.utcnow()
            row.frame_count = session.frame_count
            row.size_bytes = session.size_bytes
            await db.commit()

    logger.info(
        "Sentry: ended recording for archive %s (status=%s, frames=%s, bytes=%s)",
        session.archive_id,
        status,
        session.frame_count,
        session.size_bytes,
    )


async def _flush_index_rows(archive_id: int, rows: list[tuple[int, int, int, int]]) -> None:
    async with _database.async_session() as db:
        db.add_all(
            [
                CameraRecordingFrame(archive_id=archive_id, seq=seq, ts_ms=ts_ms, offset=offset, length=length)
                for seq, ts_ms, offset, length in rows
            ]
        )
        await db.commit()


async def _persist_session_totals(session: RecordingSession) -> None:
    """Mirrors the in-memory running totals onto the DB row. Without this,
    frame_count/size_bytes only reflect reality once a session ends (set in
    _end_session) — the storage breakdown and recordings list in Settings
    would show 0 bytes for every job still actively recording."""
    async with _database.async_session() as db:
        result = await db.execute(
            select(CameraRecordingSession).where(CameraRecordingSession.archive_id == session.archive_id)
        )
        row = result.scalar_one_or_none()
        if row is not None:
            row.frame_count = session.frame_count
            row.size_bytes = session.size_bytes
            await db.commit()


_RECONNECT_BACKOFF_SECONDS = 5
_MAX_RECONNECT_ATTEMPTS = 60  # ~5 minutes of retrying before giving up for good


async def _reconnect_upstream(session: RecordingSession) -> bool:
    """Resubscribe to the printer's camera broadcaster after the upstream
    unexpectedly ended (camera socket dropped, printer's single camera slot
    briefly taken by something else, transient network blip, etc). Without
    this, a session that loses its camera connection mid-print silently stops
    recording forever while staying "active" until the print itself
    completes — which is exactly what happened in production: sessions
    captured ~10 frames then went dark for 30+ minutes with no recording and
    no error, because the pump exited quietly on upstream-end and nothing
    ever tried again.
    """
    try:
        await session.broadcaster.unsubscribe(session.queue)
    except Exception:
        pass  # best-effort; the broadcaster may already consider it gone
    try:
        session.queue = await session.broadcaster.subscribe(pinned=True)
        return True
    except Exception:
        logger.exception("Sentry: reconnect failed for archive %s", session.archive_id)
        return False


async def _pump_session(session: RecordingSession) -> None:
    """Consume frames from the shared broadcaster and append them to this
    session's framelog file. File format per frame: [4B length][8B ts_ms][JPEG bytes],
    big-endian. The frame index stores `offset` pointing at the JPEG bytes
    (i.e. past the 12-byte header) so the frame-serving API can pread() directly.

    Runs an outer retry loop: if the upstream ends unexpectedly (not because
    stop_session() was called), reconnect with backoff instead of giving up.

    The whole loop is wrapped in ONE outer try/except for CancelledError —
    important: a naive per-inner-loop catch misses cancellation that lands
    during the reconnect backoff `sleep()`, which would propagate up through
    `_end_session`'s `await session.pump_task` and skip the final DB status
    commit entirely (a real regression caught by the test suite: sessions
    never reached 'completed'/'orphaned' when cancelled mid-backoff).
    """
    reconnect_attempts = 0
    try:
        with open(session.file_path, "ab") as fh:
            while True:
                pending_rows: list[tuple[int, int, int, int]] = []
                try:
                    while True:
                        chunk = await session.queue.get()
                        if not chunk:
                            logger.warning(
                                "Sentry: camera upstream ended for archive %s (printer %s)",
                                session.archive_id,
                                session.printer_id,
                            )
                            break
                        frame = _extract_jpeg(chunk)
                        if frame is None:
                            continue

                        ts_ms = int(time.time() * 1000)
                        header = len(frame).to_bytes(4, "big") + ts_ms.to_bytes(8, "big")
                        fh.write(header)
                        offset = fh.tell()
                        fh.write(frame)
                        fh.flush()

                        seq = session.frame_count
                        session.frame_count += 1
                        session.size_bytes += len(frame)
                        reconnect_attempts = 0  # any real frame resets the backoff counter
                        pending_rows.append((seq, ts_ms, offset, len(frame)))
                        if len(pending_rows) >= _FRAME_INDEX_BATCH:
                            await _flush_index_rows(session.archive_id, pending_rows)
                            await _persist_session_totals(session)
                            pending_rows = []
                except Exception:
                    logger.exception("Sentry: pump crashed for archive %s", session.archive_id)
                finally:
                    if pending_rows:
                        await _flush_index_rows(session.archive_id, pending_rows)
                        await _persist_session_totals(session)

                if session.stopping:
                    return  # normal end-of-session teardown (stop_session/watchdog), not a failure

                reconnect_attempts += 1
                if reconnect_attempts > _MAX_RECONNECT_ATTEMPTS:
                    logger.error(
                        "Sentry: giving up on archive %s after %d failed reconnect attempts",
                        session.archive_id,
                        reconnect_attempts,
                    )
                    return
                await asyncio.sleep(_RECONNECT_BACKOFF_SECONDS)
                if session.stopping:
                    return
                if not await _reconnect_upstream(session):
                    continue  # loop back and retry after another backoff
    except asyncio.CancelledError:
        pass


async def _watchdog(session: RecordingSession, printer_id: int, archive_id: int) -> None:
    from backend.app.services.printer_manager import printer_manager

    try:
        deadline = time.monotonic() + _RUNNING_TIMEOUT_SECONDS
        reached_running = False
        while time.monotonic() < deadline:
            status = printer_manager.get_status(printer_id)
            if status is not None and getattr(status, "state", None) in _ACTIVE_GCODE_STATES:
                reached_running = True
                break
            await asyncio.sleep(_RUNNING_POLL_SECONDS)

        if not reached_running:
            logger.warning(
                "Sentry: archive %s never reached RUNNING within %ss, closing recording",
                archive_id,
                _RUNNING_TIMEOUT_SECONDS,
            )
            await _end_session(session, status="orphaned")
            return

        disconnected_since: float | None = None
        while True:
            await asyncio.sleep(_DISCONNECT_POLL_SECONDS)
            if archive_id not in _active_sessions:
                return  # ended normally via stop_session while we were sleeping
            if not printer_manager.is_connected(printer_id):
                disconnected_since = disconnected_since or time.monotonic()
                if time.monotonic() - disconnected_since > _DISCONNECT_TIMEOUT_SECONDS:
                    logger.warning(
                        "Sentry: printer %s disconnected for over %ss during archive %s, closing recording",
                        printer_id,
                        _DISCONNECT_TIMEOUT_SECONDS,
                        archive_id,
                    )
                    await _end_session(session, status="orphaned")
                    return
            else:
                disconnected_since = None
    except asyncio.CancelledError:
        pass


async def reconcile_on_startup() -> None:
    """Resume-or-close any session left `recording` from a prior process
    (backend restart mid-print). Mirrors printer_manager.load_awaiting_plate_clear_from_db()'s
    shape: query rows implying "should have in-memory tracking", rebuild it.
    """
    from backend.app.services.printer_manager import printer_manager

    async with _database.async_session() as db:
        result = await db.execute(select(CameraRecordingSession).where(CameraRecordingSession.status == "recording"))
        stale_sessions = result.scalars().all()

        for row in stale_sessions:
            archive_result = await db.execute(select(PrintArchive).where(PrintArchive.id == row.archive_id))
            archive = archive_result.scalar_one_or_none()
            still_printing = (
                archive is not None
                and archive.status == "printing"
                and printer_manager.is_connected(row.printer_id)
            )
            if not still_printing:
                row.status = "orphaned"
                row.stopped_at = datetime.utcnow()
                logger.info(
                    "Sentry: closing orphaned recording for archive %s from a previous run (printer offline or job no longer printing)",
                    row.archive_id,
                )
                continue

            printer = printer_manager.get_printer(row.printer_id)
            if printer is None:
                row.status = "orphaned"
                row.stopped_at = datetime.utcnow()
                continue

            logger.info("Sentry: resuming recording for archive %s after restart", row.archive_id)
            # resume_row=row is required here — without it, start_session()
            # would try to INSERT a fresh CameraRecordingSession row and hit
            # the archive_id UNIQUE constraint, since `row` already exists.
            resumed = await start_session(printer, row.printer_id, row.archive_id, resume_row=row)
            if not resumed:
                row.status = "orphaned"
                row.stopped_at = datetime.utcnow()

        await db.commit()
