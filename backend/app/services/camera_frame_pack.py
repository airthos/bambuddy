"""Sentry playback: on-demand half-resolution JPEG chunk packing.

The timeline UI (CameraTimelineView) plays a recording as an *image
sequence* on a <canvas> -- it fetches fixed-size chunks of half-res JPEGs,
keeps a bounded window near the playhead buffered, and swaps decoded frames
on a timer. There is no transcode and no codec buffer, so there is nothing
that can stall "buffered-but-frozen" the way the old all-intra HLS pipeline
did (a failed segment/PTS gap froze playback indefinitely).

Chunks are generated lazily from the recording's existing framelog on first
request and cached to disk -- nothing is pre-encoded, and pre-existing
recordings need no migration. A chunk is a fixed count of consecutive frames
*by ordinal position* (ordered by seq), matching the client's frame-array
index so a gap in seq values can't desync the two.

Chunk wire format (one HTTP response body, all integers big-endian):
    [uint32 count][uint32 len_0]...[uint32 len_{count-1}]  <jpeg_0><jpeg_1>...
The client reads the count + length table, then slices each JPEG out by
offset. ts_ms per frame comes from the separate lightweight /frames list.
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import struct
import subprocess
import tempfile
from pathlib import Path

from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.config import settings as app_settings
from backend.app.models.camera_recording import CameraRecordingFrame, CameraRecordingSession

logger = logging.getLogger(__name__)

RECORDINGS_DIR_NAME = "camera_recordings"
# Must match CHUNK_FRAMES in the frontend player. 50 frames ≈ ~1.3MB half-res
# per chunk: small enough for a ~sub-second first frame / cold scrub, large
# enough that the request count stays modest.
CHUNK_FRAMES = 50
_SCALE = 0.5
_QUALITY = 80

# Cap idle gaps in the downloaded timelapse the same way playback does, so a
# long capture gap (printer offline / paused) doesn't become a multi-second
# frozen hold in the exported video.
_DOWNLOAD_SPEED = 100
_DOWNLOAD_FPS = 30
_MAX_GAP_SECONDS = 4.0


def pack_dir(printer_id: int, archive_id: int) -> Path:
    return Path(app_settings.base_dir) / RECORDINGS_DIR_NAME / str(printer_id) / f"{archive_id}_pack"


def _downscale(data: bytes, scale: float = _SCALE) -> bytes:
    im = Image.open(io.BytesIO(data))
    w, h = im.size
    nw = max(2, (int(w * scale) // 2) * 2)
    nh = max(2, (int(h * scale) // 2) * 2)
    im = im.convert("RGB").resize((nw, nh), Image.Resampling.BILINEAR)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=_QUALITY)
    return buf.getvalue()


def _pack(jpegs: list[bytes]) -> bytes:
    header = struct.pack(">I", len(jpegs)) + b"".join(struct.pack(">I", len(j)) for j in jpegs)
    return header + b"".join(jpegs)


def _build_pack_sync(framelog_path: str, frames: list[tuple[int, int]]) -> bytes:
    """frames: [(offset, length), ...] into the framelog. Downscales each and packs."""
    out: list[bytes] = []
    with open(framelog_path, "rb") as fh:
        for offset, length in frames:
            fh.seek(offset)
            data = fh.read(length)
            try:
                out.append(_downscale(data))
            except Exception:  # keep the original bytes if a frame won't decode
                out.append(data)
    return _pack(out)


async def get_chunk(db: AsyncSession, session: CameraRecordingSession, chunk: int) -> bytes | None:
    """Packed half-res bytes for the chunk-th group of CHUNK_FRAMES frames
    (by ordinal position). Serves a cached copy if the chunk is complete and
    already built; otherwise builds it (off the event loop) and caches complete
    chunks. Returns None if the chunk index is past the end of the recording."""
    result = await db.execute(
        select(CameraRecordingFrame.offset, CameraRecordingFrame.length)
        .where(CameraRecordingFrame.archive_id == session.archive_id)
        .order_by(CameraRecordingFrame.seq)
        .offset(chunk * CHUNK_FRAMES)
        .limit(CHUNK_FRAMES)
    )
    rows = result.all()
    if not rows:
        return None

    complete = len(rows) == CHUNK_FRAMES  # the trailing partial chunk of a live recording keeps growing
    cache_path = pack_dir(session.printer_id, session.archive_id) / f"chunk_{chunk:05d}.bin"
    if complete and cache_path.exists():
        try:
            return cache_path.read_bytes()
        except OSError:
            pass

    data = await asyncio.to_thread(_build_pack_sync, session.file_path, [(r.offset, r.length) for r in rows])

    if complete:
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = cache_path.with_suffix(".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, cache_path)  # atomic: a concurrent reader never sees a half-written file
        except OSError as e:
            logger.warning("Sentry: failed to cache pack chunk %s for archive %s: %s", chunk, session.archive_id, e)
    return data


# Small quarter-res still used as the timeline's per-job preview tile.
_THUMB_SCALE = 0.25


async def get_thumbnail(db: AsyncSession, session: CameraRecordingSession) -> bytes | None:
    """A single small representative frame (the middle one by ordinal) for use
    as a timeline preview tile. Built on demand and cached to disk for finished
    recordings; a live recording rebuilds each time since its midpoint moves.
    Returns None if the recording has no frames."""
    count = session.frame_count or 0
    if count <= 0:
        # frame_count may lag for very fresh sessions -- fall back to a count query.
        result = await db.execute(
            select(func.count()).select_from(CameraRecordingFrame).where(
                CameraRecordingFrame.archive_id == session.archive_id
            )
        )
        count = result.scalar_one() or 0
    if count <= 0:
        return None

    mid = count // 2
    result = await db.execute(
        select(CameraRecordingFrame.offset, CameraRecordingFrame.length)
        .where(CameraRecordingFrame.archive_id == session.archive_id)
        .order_by(CameraRecordingFrame.seq)
        .offset(mid)
        .limit(1)
    )
    row = result.first()
    if row is None:
        return None

    is_live = session.status == "recording"
    cache_path = pack_dir(session.printer_id, session.archive_id) / "thumb.jpg"
    if not is_live and cache_path.exists():
        try:
            return cache_path.read_bytes()
        except OSError:
            pass

    def _build() -> bytes:
        with open(session.file_path, "rb") as fh:
            fh.seek(row.offset)
            data = fh.read(row.length)
        try:
            return _downscale(data, _THUMB_SCALE)
        except Exception:
            return data

    data = await asyncio.to_thread(_build)
    if not is_live:
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = cache_path.with_suffix(".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, cache_path)
        except OSError as e:
            logger.warning("Sentry: failed to cache thumbnail for archive %s: %s", session.archive_id, e)
    return data


async def render_timelapse(session: CameraRecordingSession) -> bytes | None:
    """Render the recording's framelog into a downloadable MP4 timelapse at
    _DOWNLOAD_SPEED (100x) real-time. Inter-frame gaps are capped so idle periods
    don't become long frozen holds. Returns None if there are no frames."""
    async with _database().async_session() as db:  # type: ignore[misc]
        result = await db.execute(
            select(CameraRecordingFrame.ts_ms, CameraRecordingFrame.offset, CameraRecordingFrame.length)
            .where(CameraRecordingFrame.archive_id == session.archive_id)
            .order_by(CameraRecordingFrame.seq)
        )
        rows = [(ts, off, ln) for ts, off, ln in result.all()]
    if not rows:
        return None
    return await asyncio.to_thread(_render_timelapse_sync, session.file_path, rows)


def _render_timelapse_sync(framelog_path: str, rows: list[tuple[int, int, int]]) -> bytes:
    with tempfile.TemporaryDirectory(prefix="sentry-dl-") as tmp_dir:
        tmp = Path(tmp_dir)
        concat_lines: list[str] = []
        with open(framelog_path, "rb") as fh:
            for i, (ts_ms, offset, length) in enumerate(rows):
                fh.seek(offset)
                data = fh.read(length)
                try:
                    data = _downscale(data)
                except Exception:
                    pass
                frame_file = tmp / f"{i:06d}.jpg"
                frame_file.write_bytes(data)
                if i + 1 < len(rows):
                    real_dt = min(_MAX_GAP_SECONDS, max(0.001, (rows[i + 1][0] - ts_ms) / 1000))
                else:
                    real_dt = 1.0
                concat_lines.append(f"file '{frame_file.as_posix()}'")
                concat_lines.append(f"duration {max(0.001, real_dt / _DOWNLOAD_SPEED):.4f}")
        concat_lines.append(f"file '{(tmp / f'{len(rows) - 1:06d}.jpg').as_posix()}'")
        (tmp / "concat.txt").write_text("\n".join(concat_lines))

        out_path = tmp / "out.mp4"
        cmd = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(tmp / "concat.txt"),
            "-vsync", "vfr", "-vf", f"fps={_DOWNLOAD_FPS}",
            "-c:v", "libx264", "-preset", "medium", "-crf", "23",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out_path),
        ]
        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg exited {proc.returncode}: {proc.stderr.decode(errors='replace')[-2000:]}")
        return out_path.read_bytes()


def _database():
    # Local import keeps this module importable without eagerly pulling the DB
    # engine (mirrors camera_recorder's late _database use).
    from backend.app.core import database

    return database
