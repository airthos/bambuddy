"""Airtho fork, Fix 11 (docs/airtho/fixes.md): a 550 on the STOR reconnects the printer.

Observed 2026-07-14 on Airtho 3DP 2 (items 1427-1430): the FTP login succeeded
every time but the STOR was refused with 550 in ~25 ms. The printer's FTP/SD
side was wedged; a fresh FTP socket could not clear it, an operator reconnect
(fresh MQTT session) did. Upstream fails a 550 outright because it can also be
the file's own path, so the fork reconnects and keeps the job only for the first
FTP_WEDGE_RECONNECT_ATTEMPTS refusals in a row, then fails it as upstream does.

Uses the upstream #3210 harness so the fork's path is exercised through the same
check_queue → _start_print flow as upstream's refusal handling.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from tests.unit.test_scheduler_upload_requeue_3210 import (  # noqa: F401  (fixture import)
    HANDSHAKE,
    REFUSING_IP,
    _item,
    _scheduler,
    _upload_refused_by,
    farm,
)

from backend.app.services.bambu_ftp import FtpFailure, FtpFailureKind
from backend.app.services.print_scheduler import FTP_WEDGE_RECONNECT_ATTEMPTS

pytestmark = pytest.mark.unit

STOR_550 = FtpFailure(FtpFailureKind.NOT_FOUND, "550 Permission denied.", "550")


def _reconnect_patches():
    disconnect = MagicMock()
    connect = AsyncMock(return_value=True)
    return (
        disconnect,
        connect,
        patch("backend.app.services.print_scheduler.printer_manager.disconnect_printer", disconnect),
        patch("backend.app.services.print_scheduler.printer_manager.connect_printer", connect),
    )


class TestStor550Wedge:
    @pytest.mark.asyncio
    async def test_a_550_reconnects_the_printer_and_keeps_the_job(self, farm):
        item_id = await farm.add_item(printer_id=farm.ids.refusing)
        disconnect, connect, p1, p2 = _reconnect_patches()

        with p1, p2:
            async with _scheduler(farm, _upload_refused_by(REFUSING_IP, STOR_550)) as scheduler:
                await scheduler.check_queue()

        item = await _item(farm, item_id)
        assert item.status == "pending"
        assert item.printer_id == farm.ids.refusing
        disconnect.assert_called_once_with(farm.ids.refusing)
        connect.assert_awaited_once()
        scheduler.failed_notify.assert_not_awaited()
        assert farm.ids.refusing in scheduler._upload_backoff

    @pytest.mark.asyncio
    async def test_a_550_that_keeps_coming_back_fails_the_job_like_upstream(self, farm):
        """A 550 that is really the file's path must not requeue forever."""
        item_id = await farm.add_item(printer_id=farm.ids.refusing)
        disconnect, connect, p1, p2 = _reconnect_patches()

        with p1, p2:
            async with _scheduler(farm, _upload_refused_by(REFUSING_IP, STOR_550)) as scheduler:
                scheduler._upload_refusals[farm.ids.refusing] = FTP_WEDGE_RECONNECT_ATTEMPTS
                await scheduler.check_queue()

        item = await _item(farm, item_id)
        assert item.status == "failed"
        disconnect.assert_not_called()
        connect.assert_not_awaited()
        scheduler.failed_notify.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_other_refusals_do_not_reconnect(self, farm):
        """Only a 550 on a reachable printer is the wedge; a handshake failure is not."""
        await farm.add_item(printer_id=farm.ids.refusing)
        disconnect, connect, p1, p2 = _reconnect_patches()

        with p1, p2:
            async with _scheduler(farm, _upload_refused_by(REFUSING_IP, HANDSHAKE)) as scheduler:
                await scheduler.check_queue()

        disconnect.assert_not_called()
        connect.assert_not_awaited()
