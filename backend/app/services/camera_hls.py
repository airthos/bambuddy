"""Sentry mode: incremental HLS transcoding of a recording's packed JPEG
frames, so the timeline UI can play and frame-accurately scrub through
footage in a native <video> element -- including scrubbing back through
hours of a still-recording print, not just a finished one.

Per-frame <img> fetching (the original approach) never played or scrubbed
smoothly: every frame is a separate HTTP round-trip plus decode, so the
browser can't buffer ahead the way a real video format lets it. HLS is the
standard prebuilt answer to "play and seek through a stream that's still
growing" -- the same tech behind live-TV DVR and Twitch/YouTube-live
rewind: a playlist that gets new segments appended as they're produced,
which any HLS-capable player (native in Safari, hls.js everywhere else)
treats as one continuously-extending, fully seekable timeline.

Segments are built from fixed-size batches of frames (_FRAMES_PER_SEGMENT)
via ffmpeg's concat demuxer, all-intra encoded (-g 1 -keyint_min 1
-sc_threshold 0) so seeking to a specific frame is exact and instant -- no
dependency chain to decode through, which matters because frames are
irregularly spaced (sub-1fps, variable network timing).

State (which frames have already been segmented, the next segment number,
whether the playlist has been closed out) lives in a small state.json
sidecar next to the segments themselves, not the DB -- it travels with the
recording's files on disk and needs no schema beyond
CameraRecordingSession's existing video_path/video_status columns.
"""

from __future__ import annotations

import asyncio
import json
import logging
import tempfile
from pathlib import Path

from sqlalchemy import select

from backend.app.core import database as _database
from backend.app.core.config import settings as app_settings
from backend.app.models.camera_recording import CameraRecordingFrame, CameraRecordingSession

logger = logging.getLogger(__name__)

RECORDINGS_DIR_NAME = "camera_recordings"
_FRAMES_PER_SEGMENT = 30
_LIVE_POLL_SECONDS = 20
_TARGET_DURATION = 600  # generous fixed upper bound -- real segments are far shorter
_DEFAULT_LAST_FRAME_DURATION = 1.0
_STATE_FILE = "state.json"
_PLAYLIST_FILE = "playlist.m3u8"


def hls_dir(printer_id: int, archive_id: int) -> Path:
    return Path(app_settings.base_dir) / RECORDINGS_DIR_NAME / str(printer_id) / f"{archive_id}_hls"


def _read_state(directory: Path) -> dict:
    state_path = directory / _STATE_FILE
    if not state_path.exists():
        return {"last_seq": -1, "next_segment": 0, "finalized": False}
    try:
        return json.loads(state_path.read_text())
    except (OSError, ValueError):
        return {"last_seq": -1, "next_segment": 0, "finalized": False}


def _write_state(directory: Path, state: dict) -> None:
    (directory / _STATE_FILE).write_text(json.dumps(state))


def _write_playlist_header(directory: Path) -> None:
    playlist = directory / _PLAYLIST_FILE
    if playlist.exists():
        return
    playlist.write_text(
        "#EXTM3U\n"
        "#EXT-X-VERSION:3\n"
        f"#EXT-X-TARGETDURATION:{_TARGET_DURATION}\n"
        "#EXT-X-PLAYLIST-TYPE:EVENT\n"
        "#EXT-X-MEDIA-SEQUENCE:0\n"
    )


def _reopen_playlist_if_finalized(directory: Path, state: dict) -> None:
    """A resumed recording (e.g. a session wrongly orphaned mid-print and
    later revived) may already have been finalized with #EXT-X-ENDLIST.
    Appending more segments after that line violates the HLS spec and
    confuses players, so strip it and clear the flag before continuing."""
    if not state.get("finalized"):
        return
    playlist = directory / _PLAYLIST_FILE
    if playlist.exists():
        lines = playlist.read_text().splitlines(keepends=True)
        lines = [ln for ln in lines if ln.strip() != "#EXT-X-ENDLIST"]
        playlist.write_text("".join(lines))
    state["finalized"] = False


async def _pending_frames(archive_id: int, after_seq: int) -> list[CameraRecordingFrame]:
    async with _database.async_session() as db:
        result = await db.execute(
            select(CameraRecordingFrame)
            .where(CameraRecordingFrame.archive_id == archive_id, CameraRecordingFrame.seq > after_seq)
            .order_by(CameraRecordingFrame.seq)
        )
        return list(result.scalars().all())


async def _write_segment(
    framelog_path: str,
    directory: Path,
    chunk: list[CameraRecordingFrame],
    next_ts_ms: int | None,
    segment_index: int,
) -> float:
    """Encodes one batch of frames into the next .ts segment. Returns its duration in seconds."""
    output_path = directory / f"seg_{segment_index:05d}.ts"

    with tempfile.TemporaryDirectory(prefix="sentry-hls-") as tmp_dir:
        tmp = Path(tmp_dir)
        concat_lines: list[str] = []
        total_duration = 0.0
        with open(framelog_path, "rb") as fh:
            for i, frame in enumerate(chunk):
                fh.seek(frame.offset)
                data = fh.read(frame.length)
                frame_file = tmp / f"{i:06d}.jpg"
                frame_file.write_bytes(data)
                if i + 1 < len(chunk):
                    duration = max(0.05, (chunk[i + 1].ts_ms - frame.ts_ms) / 1000)
                elif next_ts_ms is not None:
                    duration = max(0.05, (next_ts_ms - frame.ts_ms) / 1000)
                else:
                    duration = _DEFAULT_LAST_FRAME_DURATION
                total_duration += duration
                concat_lines.append(f"file '{frame_file.as_posix()}'")
                concat_lines.append(f"duration {duration:.3f}")
        # The concat demuxer's duration on the final listed entry is
        # unreliable across ffmpeg versions unless the file is repeated
        # without a trailing duration -- harmless no-op where not needed.
        concat_lines.append(f"file '{(tmp / f'{len(chunk) - 1:06d}.jpg').as_posix()}'")
        concat_path = tmp / "concat.txt"
        concat_path.write_text("\n".join(concat_lines))

        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_path),
            "-vsync",
            "vfr",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-g",
            "1",
            "-keyint_min",
            "1",
            "-sc_threshold",
            "0",
            "-f",
            "mpegts",
            str(output_path),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg exited {proc.returncode}: {stderr.decode(errors='replace')[-2000:]}")

    with open(directory / _PLAYLIST_FILE, "a") as f:
        f.write(f"#EXTINF:{total_duration:.3f},\n{output_path.name}\n")

    return total_duration


async def _drain(archive_id: int, framelog_path: str, directory: Path, *, finalize: bool) -> bool:
    """Encodes as many full segments as are currently available. If
    finalize, also flushes a final partial (< _FRAMES_PER_SEGMENT) batch.
    Returns True if at least one segment was written."""
    wrote_any = False
    while True:
        state = _read_state(directory)
        _reopen_playlist_if_finalized(directory, state)
        pending = await _pending_frames(archive_id, state.get("last_seq", -1))
        if not pending or (not finalize and len(pending) < _FRAMES_PER_SEGMENT):
            _write_state(directory, state)
            return wrote_any

        chunk = pending[:_FRAMES_PER_SEGMENT]
        remaining_after_chunk = pending[len(chunk) :]
        next_ts_ms = remaining_after_chunk[0].ts_ms if remaining_after_chunk else None

        _write_playlist_header(directory)
        await _write_segment(framelog_path, directory, chunk, next_ts_ms, state.get("next_segment", 0))
        wrote_any = True

        state["last_seq"] = chunk[-1].seq
        state["next_segment"] = state.get("next_segment", 0) + 1
        _write_state(directory, state)

        if not remaining_after_chunk:
            return wrote_any


async def _mark_ready(archive_id: int, directory: Path) -> None:
    async with _database.async_session() as db:
        result = await db.execute(select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive_id))
        row = result.scalar_one_or_none()
        if row is not None and row.video_status != "ready":
            row.video_path = str(directory / _PLAYLIST_FILE)
            row.video_status = "ready"
            await db.commit()


async def live_loop(session) -> None:
    """Runs alongside an active recording's pump/watchdog tasks, periodically
    turning newly-captured frames into playable segments as they arrive --
    this is what lets a still-recording print be scrubbed hours back."""
    directory = hls_dir(session.printer_id, session.archive_id)
    directory.mkdir(parents=True, exist_ok=True)
    try:
        while True:
            await asyncio.sleep(_LIVE_POLL_SECONDS)
            if session.stopping:
                return
            try:
                wrote = await _drain(session.archive_id, str(session.file_path), directory, finalize=False)
                if wrote:
                    await _mark_ready(session.archive_id, directory)
            except Exception:
                logger.exception("Sentry: HLS live segment failed for archive %s", session.archive_id)
    except asyncio.CancelledError:
        pass


async def finalize(archive_id: int, printer_id: int, framelog_path: str) -> None:
    """Flushes any leftover frames into a final segment and closes the
    playlist. Safe to call repeatedly (e.g. from the retention sweeper's
    backlog pass) -- a cheap no-op once already finalized."""
    directory = hls_dir(printer_id, archive_id)
    if _read_state(directory).get("finalized"):
        return
    directory.mkdir(parents=True, exist_ok=True)
    try:
        wrote = await _drain(archive_id, framelog_path, directory, finalize=True)
        state = _read_state(directory)
        playlist = directory / _PLAYLIST_FILE
        if playlist.exists():
            with open(playlist, "a") as f:
                f.write("#EXT-X-ENDLIST\n")
            wrote = True
        state["finalized"] = True
        _write_state(directory, state)
        if wrote:
            await _mark_ready(archive_id, directory)
    except Exception:
        logger.exception("Sentry: HLS finalize failed for archive %s", archive_id)
        async with _database.async_session() as db:
            result = await db.execute(select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive_id))
            row = result.scalar_one_or_none()
            if row is not None and row.video_status != "ready":
                row.video_status = "failed"
                await db.commit()


async def encode_backlog() -> None:
    """Catches sessions that ended without ever finalizing -- pre-existing
    recordings from before this feature shipped, or a session whose process
    crashed between its last live segment and finalize(). Called from the
    retention sweeper's existing 15-minute cadence rather than adding a
    fourth scheduler task. finalize() short-circuits instantly (a state.json
    read, no ffmpeg spawn) for anything already done, so no extra
    bookkeeping is needed here to avoid redundant work."""
    async with _database.async_session() as db:
        result = await db.execute(
            select(
                CameraRecordingSession.archive_id,
                CameraRecordingSession.printer_id,
                CameraRecordingSession.file_path,
            ).where(
                CameraRecordingSession.status != "recording",
                CameraRecordingSession.video_status != "failed",
            )
        )
        rows = result.all()

    for archive_id, printer_id, framelog_path in rows:
        await finalize(archive_id, printer_id, framelog_path)
