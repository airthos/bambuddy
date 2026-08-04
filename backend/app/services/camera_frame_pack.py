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
import bisect
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

# The downloaded timelapse is always the same shape regardless of how long the
# print ran: exactly _DOWNLOAD_SECONDS at _DOWNLOAD_FPS, i.e. a fixed
# _DOWNLOAD_TARGET_FRAMES frames. A 30-minute print and an 18-hour print both
# export as a one-minute clip -- the recording is *compressed into* that budget
# rather than played at a fixed speed multiplier (which made export length
# unpredictable and long prints unwatchable).
_DOWNLOAD_SECONDS = 60
_DOWNLOAD_FPS = 30
_DOWNLOAD_TARGET_FRAMES = _DOWNLOAD_SECONDS * _DOWNLOAD_FPS
# Cap idle gaps when spacing the sampled frames, the same way playback does, so
# a long capture gap (printer offline / paused) doesn't eat a big share of the
# one-minute budget on a single frozen frame.
_MAX_GAP_SECONDS = 4.0
# Quality for frames the exporter has to re-encode (only ones whose dimensions
# differ from the recording's first frame). Every other frame is handed to ffmpeg
# as its original bytes at native resolution, so this is a rare fallback path.
_EXPORT_REENCODE_QUALITY = 95


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
    """Render the recording's framelog into a downloadable MP4 timelapse that is
    always exactly _DOWNLOAD_SECONDS long at _DOWNLOAD_FPS, in the frames' native
    resolution. The recording is compressed into that fixed budget by sampling
    _DOWNLOAD_TARGET_FRAMES frames from it. Returns None if there are no frames."""
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


def _pick_export_frames(ts_list: list[int], target: int) -> list[int]:
    """Frame indices to export, as a non-decreasing list of exactly `target`
    entries (so the clip is always the same length).

    Sampling is spread evenly over *gap-capped elapsed time* rather than over
    ordinal position, because capture is bursty: a print's startup/leveling
    burst can be 30fps while the body of the print is one frame every second or
    two. Ordinal sampling would hand the burst a wildly disproportionate share
    of the one-minute budget; time sampling makes the clip read like a real
    timelapse of the print. Idle gaps are capped the same way playback caps them
    so a printer-offline stretch can't eat the budget on one frozen frame.

    When the recording has fewer frames than the budget, indices repeat -- the
    export holds on frames instead of coming out short.
    """
    n = len(ts_list)
    if n == 0 or target <= 0:
        return []
    if n == 1:
        return [0] * target
    cum = [0.0] * n
    for i in range(1, n):
        cum[i] = cum[i - 1] + min(_MAX_GAP_SECONDS, max(0.0, (ts_list[i] - ts_list[i - 1]) / 1000))
    total = cum[-1]
    if total <= 0:  # every frame shares a timestamp -- nothing to weight by
        return [min(n - 1, (i * n) // target) for i in range(target)]
    if target == 1:
        return [0]
    out: list[int] = []
    for k in range(target):
        t = total * k / (target - 1)  # spans first frame .. last frame inclusive
        j = bisect.bisect_right(cum, t) - 1
        out.append(min(n - 1, max(0, j)))
    return out


def _jpeg_size(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as im:  # header-only, no pixel decode
        return im.size


def _resize_to(data: bytes, size: tuple[int, int]) -> bytes:
    im = Image.open(io.BytesIO(data)).convert("RGB").resize(size, Image.Resampling.BILINEAR)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=_EXPORT_REENCODE_QUALITY)
    return buf.getvalue()


def _render_timelapse_sync(framelog_path: str, rows: list[tuple[int, int, int]]) -> bytes:
    picks = _pick_export_frames([r[0] for r in rows], _DOWNLOAD_TARGET_FRAMES)

    def read_frame(src_i: int) -> bytes:
        with open(framelog_path, "rb") as fh:
            fh.seek(rows[src_i][1])
            return fh.read(rows[src_i][2])

    # ffmpeg's image2 demuxer needs every input image at the same size. Take the
    # size from the first frame that decodes; the rare frame that differs gets
    # resampled to it, and everything else is written byte-for-byte so the export
    # keeps the camera's native resolution and original JPEG quality.
    target_size: tuple[int, int] | None = None
    for src_i in dict.fromkeys(picks):
        try:
            target_size = _jpeg_size(read_frame(src_i))
            break
        except Exception:
            continue
    if target_size is None:
        raise RuntimeError("no decodable frames in recording")

    with tempfile.TemporaryDirectory(prefix="sentry-dl-") as tmp_dir:
        tmp = Path(tmp_dir)
        written: dict[int, Path] = {}
        with open(framelog_path, "rb") as fh:
            for out_i, src_i in enumerate(picks):
                dest = tmp / f"{out_i:06d}.jpg"
                prev = written.get(src_i)
                if prev is not None:
                    # A held frame (recording shorter than the budget): hardlink
                    # rather than duplicate full-res bytes on disk.
                    try:
                        os.link(prev, dest)
                    except OSError:
                        dest.write_bytes(prev.read_bytes())
                    continue
                fh.seek(rows[src_i][1])
                data = fh.read(rows[src_i][2])
                try:
                    if _jpeg_size(data) != target_size:
                        data = _resize_to(data, target_size)
                except Exception:
                    pass  # unreadable frame: hand the bytes to ffmpeg and let it skip
                dest.write_bytes(data)
                written[src_i] = dest

        out_path = tmp / "out.mp4"
        cmd = [
            "ffmpeg", "-y",
            "-framerate", str(_DOWNLOAD_FPS), "-start_number", "0", "-i", str(tmp / "%06d.jpg"),
            # Odd native dimensions can't be encoded as yuv420p; this is a no-op
            # for the usual even-sized camera frames.
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-frames:v", str(len(picks)),
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
