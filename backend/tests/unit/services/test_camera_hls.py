"""Unit tests for incremental HLS segmenting (camera_hls.py).

The real ffmpeg subprocess call is mocked out (not every dev machine has
ffmpeg on PATH, and these tests are about the segment/state/playlist
bookkeeping logic, not ffmpeg itself) -- the fake just writes an empty
placeholder .ts file so downstream playlist-writing code has something to
point at.
"""

from __future__ import annotations

import json

import pytest

from backend.app.models.camera_recording import CameraRecordingFrame, CameraRecordingSession
from backend.app.services import camera_hls

pytestmark = pytest.mark.asyncio


class _FakeProcess:
    def __init__(self, output_path):
        self._output_path = output_path

    async def communicate(self):
        self._output_path.write_bytes(b"")
        return b"", b""

    @property
    def returncode(self):
        return 0


def _patch_ffmpeg(monkeypatch):
    """Replaces the ffmpeg subprocess call with a fake that just touches the
    output file the real command line would have produced."""

    async def _fake_create_subprocess_exec(*cmd, **kwargs):
        output_path = camera_hls.Path(cmd[-1])
        return _FakeProcess(output_path)

    monkeypatch.setattr(camera_hls.asyncio, "create_subprocess_exec", _fake_create_subprocess_exec)


async def _add_frames(db_session, archive_id: int, count: int, *, start_seq: int = 0, start_ts: int = 0):
    for i in range(count):
        db_session.add(
            CameraRecordingFrame(
                archive_id=archive_id,
                seq=start_seq + i,
                ts_ms=start_ts + i * 1000,
                offset=0,
                length=10,
            )
        )
    await db_session.commit()


async def _make_session_row(db_session, printer_id: int, archive_id: int, framelog_path, **kwargs):
    row = CameraRecordingSession(
        archive_id=archive_id,
        printer_id=printer_id,
        status=kwargs.pop("status", "recording"),
        file_path=str(framelog_path),
        **kwargs,
    )
    db_session.add(row)
    await db_session.commit()
    return row


@pytest.fixture(autouse=True)
def _recorder_db(monkeypatch, test_engine):
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    test_async_session = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr("backend.app.core.database.async_session", test_async_session)


@pytest.fixture(autouse=True)
def _isolated_recordings_dir(monkeypatch, tmp_path):
    from backend.app.core.config import settings as app_settings

    monkeypatch.setattr(app_settings, "base_dir", tmp_path)


async def test_drain_waits_for_a_full_batch_before_encoding(monkeypatch, db_session, printer_factory, archive_factory, tmp_path):
    _patch_ffmpeg(monkeypatch)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")
    framelog = tmp_path / "framelog"
    framelog.write_bytes(b"\x00" * 100)
    await _add_frames(db_session, archive.id, count=camera_hls._FRAMES_PER_SEGMENT - 5)

    directory = camera_hls.hls_dir(printer.id, archive.id)
    directory.mkdir(parents=True)
    wrote = await camera_hls._drain(archive.id, str(framelog), directory, finalize=False)

    assert wrote is False
    assert not (directory / "playlist.m3u8").exists()


async def test_drain_encodes_once_a_full_batch_is_available(monkeypatch, db_session, printer_factory, archive_factory, tmp_path):
    _patch_ffmpeg(monkeypatch)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")
    framelog = tmp_path / "framelog"
    framelog.write_bytes(b"\x00" * 100)
    await _add_frames(db_session, archive.id, count=camera_hls._FRAMES_PER_SEGMENT)

    directory = camera_hls.hls_dir(printer.id, archive.id)
    directory.mkdir(parents=True)
    wrote = await camera_hls._drain(archive.id, str(framelog), directory, finalize=False)

    assert wrote is True
    assert (directory / "seg_00000.ts").exists()
    playlist = (directory / "playlist.m3u8").read_text()
    assert "#EXTM3U" in playlist
    assert "seg_00000.ts" in playlist
    assert "#EXT-X-ENDLIST" not in playlist  # still open -- more segments may follow

    state = json.loads((directory / "state.json").read_text())
    assert state["last_seq"] == camera_hls._FRAMES_PER_SEGMENT - 1
    assert state["next_segment"] == 1


async def test_drain_finalize_flushes_a_partial_trailing_batch(monkeypatch, db_session, printer_factory, archive_factory, tmp_path):
    _patch_ffmpeg(monkeypatch)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="completed")
    framelog = tmp_path / "framelog"
    framelog.write_bytes(b"\x00" * 100)
    await _add_frames(db_session, archive.id, count=5)  # well under a full segment

    directory = camera_hls.hls_dir(printer.id, archive.id)
    directory.mkdir(parents=True)
    wrote = await camera_hls._drain(archive.id, str(framelog), directory, finalize=True)

    assert wrote is True
    assert (directory / "seg_00000.ts").exists()


async def test_finalize_closes_playlist_and_marks_session_ready(monkeypatch, db_session, printer_factory, archive_factory, tmp_path):
    _patch_ffmpeg(monkeypatch)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="completed")
    framelog = tmp_path / "framelog"
    framelog.write_bytes(b"\x00" * 100)
    await _add_frames(db_session, archive.id, count=10)
    await _make_session_row(db_session, printer.id, archive.id, framelog, status="completed")

    await camera_hls.finalize(archive.id, printer.id, str(framelog))

    directory = camera_hls.hls_dir(printer.id, archive.id)
    playlist = (directory / "playlist.m3u8").read_text()
    assert playlist.strip().endswith("#EXT-X-ENDLIST")

    async with camera_hls._database.async_session() as db:
        from sqlalchemy import select

        result = await db.execute(select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive.id))
        row = result.scalar_one()
        assert row.video_status == "ready"
        assert row.video_path == str(directory / "playlist.m3u8")


async def test_finalize_is_idempotent(monkeypatch, db_session, printer_factory, archive_factory, tmp_path):
    """Regression guard: the retention sweeper's backlog pass calls finalize()
    for every non-recording session every 15 minutes, relying on this being
    a cheap no-op once actually done -- it must not re-spawn ffmpeg or
    double-append #EXT-X-ENDLIST."""
    _patch_ffmpeg(monkeypatch)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="completed")
    framelog = tmp_path / "framelog"
    framelog.write_bytes(b"\x00" * 100)
    await _add_frames(db_session, archive.id, count=10)
    await _make_session_row(db_session, printer.id, archive.id, framelog, status="completed")

    await camera_hls.finalize(archive.id, printer.id, str(framelog))

    calls = []
    monkeypatch.setattr(
        camera_hls.asyncio,
        "create_subprocess_exec",
        lambda *a, **k: calls.append(1) or pytest.fail("ffmpeg should not be invoked on a repeat finalize() call"),
    )

    await camera_hls.finalize(archive.id, printer.id, str(framelog))

    directory = camera_hls.hls_dir(printer.id, archive.id)
    playlist = (directory / "playlist.m3u8").read_text()
    assert playlist.count("#EXT-X-ENDLIST") == 1


async def test_reopen_playlist_strips_endlist_for_a_resumed_recording(monkeypatch, db_session, printer_factory, archive_factory, tmp_path):
    """Regression guard for the revive-terminal-row path (camera_recorder.py's
    start_session reusing an orphaned row): if that earlier attempt had
    already been finalized, appending more segments after #EXT-X-ENDLIST
    would violate the HLS spec -- the line must be stripped first."""
    _patch_ffmpeg(monkeypatch)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")
    framelog = tmp_path / "framelog"
    framelog.write_bytes(b"\x00" * 100)
    await _add_frames(db_session, archive.id, count=5)

    directory = camera_hls.hls_dir(printer.id, archive.id)
    await camera_hls.finalize(archive.id, printer.id, str(framelog))
    assert "#EXT-X-ENDLIST" in (directory / "playlist.m3u8").read_text()

    # More frames arrive after the "finished" recording is revived.
    await _add_frames(db_session, archive.id, count=camera_hls._FRAMES_PER_SEGMENT, start_seq=5, start_ts=10_000)
    wrote = await camera_hls._drain(archive.id, str(framelog), directory, finalize=False)

    assert wrote is True
    playlist = (directory / "playlist.m3u8").read_text()
    assert "#EXT-X-ENDLIST" not in playlist
    assert "seg_00001.ts" in playlist


async def test_encode_backlog_finalizes_eligible_sessions(monkeypatch, db_session, printer_factory, archive_factory, tmp_path):
    _patch_ffmpeg(monkeypatch)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="completed")
    framelog = tmp_path / "framelog"
    framelog.write_bytes(b"\x00" * 100)
    await _add_frames(db_session, archive.id, count=10)
    await _make_session_row(db_session, printer.id, archive.id, framelog, status="completed")

    await camera_hls.encode_backlog()

    directory = camera_hls.hls_dir(printer.id, archive.id)
    assert (directory / "playlist.m3u8").exists()
    assert "#EXT-X-ENDLIST" in (directory / "playlist.m3u8").read_text()


async def test_encode_backlog_skips_still_recording_sessions(monkeypatch, db_session, printer_factory, archive_factory, tmp_path):
    calls = []

    async def _fake_finalize(archive_id, printer_id, framelog_path):
        calls.append(archive_id)

    monkeypatch.setattr(camera_hls, "finalize", _fake_finalize)
    printer = await printer_factory(model="P1S")
    archive = await archive_factory(printer.id, status="printing")
    framelog = tmp_path / "framelog"
    await _make_session_row(db_session, printer.id, archive.id, framelog, status="recording")

    await camera_hls.encode_backlog()

    assert calls == []
