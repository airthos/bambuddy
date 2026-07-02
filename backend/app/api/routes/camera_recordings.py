"""Sentry-mode recording playback API — lists, serves frames from, and manages
retention for per-job camera recordings written by camera_recorder.py.
"""

import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.camera import get_printer_or_404
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.archive import PrintArchive
from backend.app.models.camera_recording import CameraRecordingFrame, CameraRecordingSession
from backend.app.models.printer import Printer
from backend.app.models.user import User
from backend.app.services.camera_recording_purge import camera_recording_purge_service

router = APIRouter(prefix="/printers", tags=["camera-recordings"])
global_router = APIRouter(prefix="/camera-recordings", tags=["camera-recordings"])


def _session_to_dict(row: CameraRecordingSession, archive: PrintArchive | None) -> dict:
    return {
        "archive_id": row.archive_id,
        "printer_id": row.printer_id,
        "status": row.status,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "stopped_at": row.stopped_at.isoformat() if row.stopped_at else None,
        "frame_count": row.frame_count,
        "size_bytes": row.size_bytes,
        "keep_forever": row.keep_forever,
        "file": archive.filename if archive else None,
        "print_name": archive.print_name if archive else None,
        "filament_type": archive.filament_type if archive else None,
        "archive_status": archive.status if archive else None,
    }


@router.get("/{printer_id}/recordings")
async def list_recordings(
    printer_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CAMERA_VIEW),
):
    """Recordings for one printer, most recent first, joined with archive metadata."""
    await get_printer_or_404(printer_id, db)

    result = await db.execute(
        select(CameraRecordingSession, PrintArchive)
        .join(PrintArchive, PrintArchive.id == CameraRecordingSession.archive_id, isouter=True)
        .where(CameraRecordingSession.printer_id == printer_id)
        .order_by(CameraRecordingSession.started_at.desc())
    )
    return [_session_to_dict(session, archive) for session, archive in result.all()]


@router.get("/{printer_id}/recordings/{archive_id}/frames")
async def list_frames(
    printer_id: int,
    archive_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CAMERA_VIEW),
):
    """Lightweight {seq, ts_ms} list for building the scrub bar — no frame bytes."""
    await get_printer_or_404(printer_id, db)

    result = await db.execute(
        select(CameraRecordingFrame.seq, CameraRecordingFrame.ts_ms)
        .where(CameraRecordingFrame.archive_id == archive_id)
        .order_by(CameraRecordingFrame.seq)
    )
    return [{"seq": seq, "ts_ms": ts_ms} for seq, ts_ms in result.all()]


@router.get("/{printer_id}/recordings/{archive_id}/frames/{seq}")
async def get_frame(
    printer_id: int,
    archive_id: int,
    seq: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CAMERA_VIEW),
):
    """Serves a single JPEG frame by seq, pread from the session's packed framelog file."""
    await get_printer_or_404(printer_id, db)

    frame_result = await db.execute(
        select(CameraRecordingFrame).where(
            CameraRecordingFrame.archive_id == archive_id, CameraRecordingFrame.seq == seq
        )
    )
    frame = frame_result.scalar_one_or_none()
    if frame is None:
        raise HTTPException(status_code=404, detail="Frame not found")

    session_result = await db.execute(
        select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive_id)
    )
    session = session_result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="Recording not found")

    try:
        fd = os.open(session.file_path, os.O_RDONLY)
        try:
            data = os.pread(fd, frame.length, frame.offset)
        finally:
            os.close(fd)
    except OSError as e:
        raise HTTPException(status_code=404, detail=f"Recording file unavailable: {e}") from e

    return Response(content=data, media_type="image/jpeg")


@router.post("/{printer_id}/recordings/{archive_id}/keep-forever")
async def set_keep_forever(
    printer_id: int,
    archive_id: int,
    keep: bool,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CAMERA_VIEW),
):
    await get_printer_or_404(printer_id, db)

    result = await db.execute(select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive_id))
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Recording not found")
    row.keep_forever = keep
    await db.commit()
    return {"archive_id": archive_id, "keep_forever": row.keep_forever}


@router.delete("/{printer_id}/recordings/{archive_id}")
async def delete_recording(
    printer_id: int,
    archive_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CAMERA_VIEW),
):
    await get_printer_or_404(printer_id, db)

    deleted = await camera_recording_purge_service.delete_one(db, archive_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Recording not found, or still recording")
    return {"deleted": True}


@global_router.get("/storage")
async def storage_summary(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CAMERA_VIEW),
):
    """Per-printer breakdown of currently-retained recording storage, mirroring
    the shape of the general storage-usage endpoint the Settings UI already uses."""
    result = await db.execute(
        select(CameraRecordingSession.printer_id, Printer.name, CameraRecordingSession.size_bytes).join(
            Printer, Printer.id == CameraRecordingSession.printer_id
        )
    )
    totals: dict[int, dict] = {}
    for printer_id, name, size_bytes in result.all():
        entry = totals.setdefault(printer_id, {"key": str(printer_id), "label": name, "bytes": 0})
        entry["bytes"] += size_bytes or 0

    total_bytes = sum(c["bytes"] for c in totals.values())
    categories = [c for c in totals.values() if c["bytes"] > 0]
    for c in categories:
        c["percent_of_total"] = (c["bytes"] / total_bytes * 100) if total_bytes else 0.0

    kept_result = await db.execute(
        select(CameraRecordingSession.size_bytes).where(CameraRecordingSession.keep_forever.is_(True))
    )
    kept_forever_bytes = sum(b or 0 for (b,) in kept_result.all())

    return {"total_bytes": total_bytes, "kept_forever_bytes": kept_forever_bytes, "categories": categories}


@global_router.post("/clear")
async def clear_recordings(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CAMERA_VIEW),
):
    """Deletes every non-pinned, non-active recording now — backs the Settings 'Clear Recordings' button."""
    count = await camera_recording_purge_service.clear_all(db)
    return {"deleted": count}
