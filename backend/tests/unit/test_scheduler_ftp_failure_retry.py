"""Regression tests for the FTP-failure dispatch path.

Observed 2026-07-14 on Airtho 3DP 2: the printer reported a dispatchable state
(FINISH) while it was actually busy finishing an auto-calibration, so its FTP
endpoint refused uploads. The scheduler dispatched queue items 1427, 1428, 1429,
1430 to it in consecutive ~30 s cycles — each failed on FTP upload and was
consumed as ``failed``. Root cause: the pre-dispatch FTP-failure path returned
without arming the ``#1157`` dispatch-hold cooldown (which only fires after a
*successful* ``start_print``), so nothing throttled the next-cycle re-dispatch
onto the same not-ready printer.

The fix, exercised here:
  1. A failed FTP upload arms the post-dispatch cooldown (``_mark_printer_dispatched``)
     so the printer is parked instead of immediately re-dispatched.
  2. The item is bounced back to ``pending`` and retried up to
     ``_max_ftp_dispatch_retries`` times before being failed for real.
  3. ``check_queue`` honours the resulting hold and skips the printer.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401  (register all mappers)
from backend.app.core.config import settings
from backend.app.core.database import Base
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.print_scheduler import PrintScheduler

PRINTER_ID = 1


async def _make_db(tmp_path):
    """In-memory DB with one connected printer and one archive-backed pending item."""
    # Real 3MF on disk so _start_print's file_path.exists() check passes.
    src = tmp_path / "job.3mf"
    src.write_bytes(b"PK\x03\x04 fake 3mf payload")

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with session_maker() as db:
        db.add(
            Printer(
                id=PRINTER_ID,
                name="Airtho 3DP 2",
                serial_number="TESTSERIAL0001",
                ip_address="10.0.0.9",
                access_code="0000",
                model="P1S",
            )
        )
        db.add(
            PrintArchive(
                id=10,
                printer_id=PRINTER_ID,
                filename="job.3mf",
                file_path="job.3mf",  # resolved against settings.base_dir (patched to tmp_path)
                file_size=123,
            )
        )
        db.add(
            PrintQueueItem(
                id=500,
                printer_id=PRINTER_ID,
                status="pending",
                position=1,
                archive_id=10,
            )
        )
        await db.commit()

    return engine, session_maker


def _ftp_failure_patches(scheduler, tmp_path, uploaded: bool):
    """Patch every dependency _start_print touches up to (and through) the FTP call."""
    mock_pm = MagicMock()
    mock_pm.is_connected.return_value = True
    mock_pm.get_status.return_value = SimpleNamespace(state="FINISH", subtask_id="s1", gcode_file=None)

    notif = MagicMock()
    notif.on_queue_job_failed = AsyncMock()

    return [
        patch.object(settings, "base_dir", tmp_path),
        patch("backend.app.services.print_scheduler.printer_manager", mock_pm),
        patch(
            "backend.app.services.print_scheduler.get_ftp_retry_settings",
            AsyncMock(return_value=(False, 0, 0.0, 30.0)),
        ),
        patch("backend.app.services.print_scheduler.delete_file_async", AsyncMock(return_value=True)),
        patch("backend.app.services.print_scheduler.upload_file_async", AsyncMock(return_value=uploaded)),
        patch("backend.app.services.print_scheduler.notification_service", notif),
        patch.object(scheduler, "_power_off_if_needed", AsyncMock()),
    ], notif


async def _dispatch_once(scheduler, session_maker, tmp_path, uploaded=False):
    """Run _start_print for item 500 with FTP returning `uploaded`; return the reloaded item."""
    patches, notif = _ftp_failure_patches(scheduler, tmp_path, uploaded)
    async with session_maker() as db:
        item = (await db.execute(select(PrintQueueItem).where(PrintQueueItem.id == 500))).scalar_one()
        from contextlib import ExitStack

        with ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            await scheduler._start_print(db, item)
        reloaded = (await db.execute(select(PrintQueueItem).where(PrintQueueItem.id == 500))).scalar_one()
    return reloaded, notif


class TestFtpFailureArmsCooldown:
    @pytest.mark.asyncio
    async def test_failed_upload_parks_printer_in_dispatch_hold(self, tmp_path):
        """The core bug: a failed dispatch must leave the printer held so the next
        cycle doesn't immediately re-dispatch onto it."""
        engine, session_maker = await _make_db(tmp_path)
        scheduler = PrintScheduler()
        assert scheduler._printer_in_dispatch_hold(PRINTER_ID) is False

        await _dispatch_once(scheduler, session_maker, tmp_path, uploaded=False)

        assert scheduler._printer_in_dispatch_hold(PRINTER_ID) is True
        await engine.dispose()


class TestFtpFailureRetryThenFail:
    @pytest.mark.asyncio
    async def test_transient_failures_requeue_then_final_fails(self, tmp_path):
        """First (max-1) failures bounce the item back to pending; the last fails it."""
        engine, session_maker = await _make_db(tmp_path)
        scheduler = PrintScheduler()
        assert scheduler._max_ftp_dispatch_retries == 3

        # Attempts 1 and 2 → requeued as pending, no failure notification.
        for expected_attempt in (1, 2):
            item, notif = await _dispatch_once(scheduler, session_maker, tmp_path, uploaded=False)
            assert item.status == "pending", f"attempt {expected_attempt} should requeue"
            assert item.started_at is None
            assert item.completed_at is None
            assert scheduler._ftp_dispatch_attempts.get(500) == expected_attempt
            notif.on_queue_job_failed.assert_not_called()

        # Attempt 3 → hard failure, notification sent, counter cleared.
        item, notif = await _dispatch_once(scheduler, session_maker, tmp_path, uploaded=False)
        assert item.status == "failed"
        assert item.completed_at is not None
        assert "3 attempts" in (item.error_message or "")
        notif.on_queue_job_failed.assert_awaited_once()
        assert 500 not in scheduler._ftp_dispatch_attempts
        await engine.dispose()


class TestFtpRetryCounterIsolation:
    @pytest.mark.asyncio
    async def test_counter_is_keyed_per_item(self, tmp_path):
        """A failure on item 500 must not consume another item's retry budget."""
        engine, session_maker = await _make_db(tmp_path)
        scheduler = PrintScheduler()

        await _dispatch_once(scheduler, session_maker, tmp_path, uploaded=False)
        assert scheduler._ftp_dispatch_attempts == {500: 1}
        # A different item id would start its own count at 0.
        assert scheduler._ftp_dispatch_attempts.get(999) is None
        await engine.dispose()


class TestCheckQueueHonoursHold:
    @pytest.mark.asyncio
    async def test_check_queue_skips_printer_in_dispatch_hold(self, tmp_path):
        """End-to-end guard: with the printer parked in a dispatch hold (as a failed
        FTP upload leaves it), check_queue must not dispatch the pending item onto it,
        even though the live state reads idle."""
        engine, session_maker = await _make_db(tmp_path)
        scheduler = PrintScheduler()
        # Simulate the state left behind by a just-failed FTP dispatch.
        scheduler._mark_printer_dispatched(PRINTER_ID, None, None)
        assert scheduler._printer_in_dispatch_hold(PRINTER_ID) is True

        start_print_mock = AsyncMock()
        with (
            patch("backend.app.services.print_scheduler.async_session", session_maker),
            patch.object(scheduler, "_get_bool_setting", AsyncMock(return_value=False)),
            patch.object(scheduler, "_is_printer_idle", return_value=True),
            patch.object(scheduler, "_check_auto_drying", AsyncMock()),
            patch.object(scheduler, "_start_print", start_print_mock),
            patch("backend.app.services.print_scheduler.printer_manager") as mock_pm,
        ):
            mock_pm.is_connected.return_value = True
            await scheduler.check_queue()

        start_print_mock.assert_not_called()
        async with session_maker() as db:
            item = (await db.execute(select(PrintQueueItem).where(PrintQueueItem.id == 500))).scalar_one()
        assert item.status == "pending"
        await engine.dispose()
