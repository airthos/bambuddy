"""Sentry-mode recording retention sweeper.

Mirrors archive_purge.py's shape (scheduler task on the same 15-minute
cadence as the library-trash/archive-purge sweepers) but simpler: recordings
have no soft-delete step — a session the user wants to keep should be
flagged `keep_forever`, which this sweeper (and the manual "Clear
Recordings" button, via `clear_all`) always skips.

Shipping this alongside the recorder isn't optional: at ~15GB/week across a
3-printer farm with no existing disk-space alerting, leaving retention
unshipped even briefly risks filling the disk (see project storage math).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core import database as _database
from backend.app.models.camera_recording import CameraRecordingFrame, CameraRecordingSession

logger = logging.getLogger(__name__)


class CameraRecordingPurgeService:
    def __init__(self):
        self._scheduler_task: asyncio.Task | None = None
        self._check_interval = 900  # matches archive_purge / library_trash cadence

    async def start_scheduler(self):
        if self._scheduler_task is not None:
            return
        logger.info("Starting Sentry recording retention sweeper")
        self._scheduler_task = asyncio.create_task(self._scheduler_loop())

    def stop_scheduler(self):
        if self._scheduler_task:
            self._scheduler_task.cancel()
            self._scheduler_task = None
            logger.info("Stopped Sentry recording retention sweeper")

    async def _scheduler_loop(self):
        from backend.app.services.camera_interval_capture import camera_interval_capture_service

        while True:
            try:
                await asyncio.sleep(self._check_interval)
                async with _database.async_session() as db:
                    deleted = await self.purge_expired(db)
                    if deleted:
                        logger.info("Sentry retention sweep: deleted %d expired recording(s)", deleted)
                async with _database.async_session() as db:
                    deleted_snapshots = await camera_interval_capture_service.purge_expired(db)
                    if deleted_snapshots:
                        logger.info("Sentry retention sweep: deleted %d expired interval snapshot(s)", deleted_snapshots)
            except asyncio.CancelledError:
                break
            except Exception as e:  # pragma: no cover - defensive
                logger.error("Error in Sentry recording retention sweeper: %s", e)
                await asyncio.sleep(60)

    @staticmethod
    def _delete_row_files(row: CameraRecordingSession) -> None:
        try:
            Path(row.file_path).unlink(missing_ok=True)
        except OSError as e:
            logger.warning("Sentry: failed to delete framelog for archive %s: %s", row.archive_id, e)

    async def _delete_rows(self, db: AsyncSession, rows: list[CameraRecordingSession]) -> int:
        for row in rows:
            self._delete_row_files(row)
            await db.execute(delete(CameraRecordingFrame).where(CameraRecordingFrame.archive_id == row.archive_id))
            await db.delete(row)
        if rows:
            await db.commit()
        return len(rows)

    async def purge_expired(self, db: AsyncSession) -> int:
        """Delete recordings older than sentry_retention_days. Never touches
        `keep_forever` rows or sessions still actively recording."""
        from backend.app.api.routes.settings import _build_settings_response

        cfg = await _build_settings_response(db)
        cutoff = datetime.utcnow() - timedelta(days=cfg.sentry_retention_days)

        result = await db.execute(
            select(CameraRecordingSession).where(
                CameraRecordingSession.keep_forever.is_(False),
                CameraRecordingSession.status != "recording",
                or_(
                    CameraRecordingSession.stopped_at < cutoff,
                    CameraRecordingSession.stopped_at.is_(None) & (CameraRecordingSession.started_at < cutoff),
                ),
            )
        )
        return await self._delete_rows(db, list(result.scalars().all()))

    async def clear_all(self, db: AsyncSession, printer_ids: list[int] | None = None) -> int:
        """Deletes every non-pinned, non-active recording now — backs the
        manual "Clear Recordings" button in Settings."""
        query = select(CameraRecordingSession).where(
            CameraRecordingSession.keep_forever.is_(False),
            CameraRecordingSession.status != "recording",
        )
        if printer_ids:
            query = query.where(CameraRecordingSession.printer_id.in_(printer_ids))
        result = await db.execute(query)
        return await self._delete_rows(db, list(result.scalars().all()))

    async def delete_one(self, db: AsyncSession, archive_id: int) -> bool:
        """Deletes a single recording regardless of keep_forever — used by the
        per-row delete button, which is an explicit user action distinct from
        the age-based/bulk sweeps above."""
        result = await db.execute(select(CameraRecordingSession).where(CameraRecordingSession.archive_id == archive_id))
        row = result.scalar_one_or_none()
        if row is None or row.status == "recording":
            return False
        await self._delete_rows(db, [row])
        return True


camera_recording_purge_service = CameraRecordingPurgeService()
