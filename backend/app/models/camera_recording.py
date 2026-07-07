from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class CameraRecordingSession(Base):
    """One Sentry-mode recording, one-to-one with a print_archives row.

    frame_count/size_bytes are running totals maintained by the recorder as
    frames are written, so storage/UI queries don't need to touch the
    (potentially large) frame index table.
    """

    __tablename__ = "camera_recording_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    archive_id: Mapped[int] = mapped_column(ForeignKey("print_archives.id", ondelete="CASCADE"), unique=True, index=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), index=True)

    # 'recording' (in progress) | 'completed' | 'orphaned' (closed early by a watchdog, e.g. printer went offline)
    status: Mapped[str] = mapped_column(String(20), default="recording")

    started_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    stopped_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    frame_count: Mapped[int] = mapped_column(Integer, default=0)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    file_path: Mapped[str] = mapped_column(String(500))

    # HLS playlist (all-intra H.264/MPEG-TS segments) incrementally transcoded
    # from the packed JPEG frames as they're captured, for native <video>
    # playback with frame-accurate seeking -- including scrubbing back
    # through a still-recording session, not just finished ones. video_path
    # is the playlist.m3u8 path; 'none' (no segments yet) | 'ready' (has at
    # least one playable segment, may still be growing) | 'failed'.
    video_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    video_status: Mapped[str] = mapped_column(String(20), default="none")

    # User-pinned — survives the retention sweeper regardless of age.
    keep_forever: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class CameraIntervalSnapshot(Base):
    """One periodic snapshot, independent of print jobs — a fixed-interval
    ambient log (e.g. every 5/10/30/60 min) rather than the per-job continuous
    recording above. Each snapshot is its own JPEG file (not packed) since the
    interval is sparse enough that file count is never a concern (e.g. 5 min
    across 3 printers = 864 files/day, nowhere near the per-frame-file problem
    continuous recording would have).
    """

    __tablename__ = "camera_interval_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), index=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    file_path: Mapped[str] = mapped_column(String(500))
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)


class CameraRecordingFrame(Base):
    """Index row for one frame inside a session's packed .framelog file.

    Frames are appended to one binary file per session (see
    camera_recorder.py) rather than one file per frame — at sub-1fps a
    farm's weekly frame count is still in the hundreds of thousands, which
    would be an unreasonable number of files on disk.
    """

    __tablename__ = "camera_recording_frames"

    id: Mapped[int] = mapped_column(primary_key=True)
    archive_id: Mapped[int] = mapped_column(ForeignKey("print_archives.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    ts_ms: Mapped[int] = mapped_column(Integer)
    offset: Mapped[int] = mapped_column(Integer)
    length: Mapped[int] = mapped_column(Integer)
