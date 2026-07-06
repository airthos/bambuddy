"""Sentry interval snapshots: a fixed-interval ambient camera log, independent
of print jobs — captures one frame per active printer every N minutes
regardless of print state (see camera_recorder.py for the per-job recorder).

Reuses the same connection-safety rule the live snapshot route already
follows: never open a second camera socket while a broadcaster (live viewer
or the per-job recorder) is already holding the printer's one allowed
connection — tap its buffered frame instead. Only opens a fresh one-shot
connection when nothing else is using the camera.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import delete, select

from backend.app.core import database as _database
from backend.app.core.config import settings as app_settings
from backend.app.models.camera_recording import CameraIntervalSnapshot
from backend.app.models.printer import Printer

logger = logging.getLogger(__name__)

SNAPSHOTS_DIR_NAME = "camera_snapshots"
_CHECK_INTERVAL_SECONDS = 30  # how often we check "is it time yet" per printer


class CameraIntervalCaptureService:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._last_capture: dict[int, datetime] = {}

    async def start_scheduler(self) -> None:
        if self._task is not None:
            return
        logger.info("Starting Sentry interval-snapshot capture loop")
        self._task = asyncio.create_task(self._loop())

    def stop_scheduler(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None
            logger.info("Stopped Sentry interval-snapshot capture loop")

    async def _loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(_CHECK_INTERVAL_SECONDS)
                await self._maybe_capture_all()
            except asyncio.CancelledError:
                break
            except Exception:  # pragma: no cover - defensive
                logger.exception("Error in Sentry interval-snapshot loop")
                await asyncio.sleep(60)

    async def _maybe_capture_all(self) -> None:
        async with _database.async_session() as db:
            from backend.app.api.routes.settings import _build_settings_response

            cfg = await _build_settings_response(db)
            if not cfg.sentry_interval_enabled:
                return

            interval = timedelta(minutes=cfg.sentry_interval_minutes)
            now = datetime.utcnow()
            result = await db.execute(select(Printer).where(Printer.is_active.is_(True)))
            printers = result.scalars().all()

        due = [p for p in printers if now - self._last_capture.get(p.id, datetime.min) >= interval]
        for printer in due:
            self._last_capture[printer.id] = now
            try:
                await self._capture_one(printer)
            except Exception:
                logger.exception("Sentry: interval snapshot failed for printer %s", printer.id)

    async def _capture_one(self, printer: Printer) -> None:
        from backend.app.api.routes.camera import is_stream_active, try_get_active_buffered_frame
        from backend.app.services.camera import capture_camera_frame_bytes

        frame: bytes | None = None
        if is_stream_active(printer.id):
            frame = try_get_active_buffered_frame(printer.id)
        if frame is None:
            frame = await capture_camera_frame_bytes(printer.ip_address, printer.access_code, printer.model)
        if frame is None:
            logger.warning("Sentry: interval snapshot capture returned nothing for printer %s", printer.id)
            return

        snapshots_dir = Path(app_settings.base_dir) / SNAPSHOTS_DIR_NAME / str(printer.id)
        snapshots_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.utcnow()
        file_path = snapshots_dir / f"{ts.strftime('%Y%m%d_%H%M%S')}.jpg"
        file_path.write_bytes(frame)

        async with _database.async_session() as db:
            db.add(
                CameraIntervalSnapshot(
                    printer_id=printer.id,
                    captured_at=ts,
                    file_path=str(file_path),
                    size_bytes=len(frame),
                )
            )
            await db.commit()

    async def purge_expired(self, db) -> int:
        from backend.app.api.routes.settings import _build_settings_response

        cfg = await _build_settings_response(db)
        cutoff = datetime.utcnow() - timedelta(days=cfg.sentry_interval_retention_days)

        result = await db.execute(select(CameraIntervalSnapshot).where(CameraIntervalSnapshot.captured_at < cutoff))
        rows = list(result.scalars().all())
        for row in rows:
            try:
                Path(row.file_path).unlink(missing_ok=True)
            except OSError as e:
                logger.warning("Sentry: failed to delete interval snapshot file for id %s: %s", row.id, e)
        if rows:
            ids = [r.id for r in rows]
            await db.execute(delete(CameraIntervalSnapshot).where(CameraIntervalSnapshot.id.in_(ids)))
            await db.commit()
        return len(rows)


camera_interval_capture_service = CameraIntervalCaptureService()
