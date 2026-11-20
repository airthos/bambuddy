"""Airtho fork, features 1c (docs/airtho/features.md): SD-card HMS auto-clear.

Transient SD-card faults (e.g. 0500_C010) block the scheduler's HMS dispatch
gate until acknowledged. The fork acks them automatically and never notifies
them. Since upstream's #3226/#3486 only report a fault the first time in a
10-minute window (and not again after a restart), the clear runs before that
bookkeeping, on every status push, throttled per printer.
"""

from unittest.mock import MagicMock, patch

import pytest

import backend.app.main as main_module
from backend.app.services.bambu_mqtt import HMSError

pytestmark = pytest.mark.unit


def _fault(attr: int, code: str) -> HMSError:
    return HMSError(code=code, attr=attr, module=(attr >> 24) & 0xFF, severity=2)


SD_FAULT = _fault(0x0500_0300, "0xC010")  # 0500_C010 MicroSD read/write exception
OTHER_FAULT = _fault(0x0300_0100, "0x8010")  # 0300_8010 hotend fan speed abnormal


@pytest.fixture(autouse=True)
def _fresh_throttle():
    main_module._sdcard_clear_sent_at.clear()
    yield
    main_module._sdcard_clear_sent_at.clear()


def _client():
    client = MagicMock()
    client.clear_hms_errors.return_value = True
    return client


def test_an_sd_fault_is_cleared_and_not_notified():
    client = _client()
    with patch.object(main_module.printer_manager, "get_client", return_value=client):
        left = main_module._auto_clear_sdcard_faults(4, [SD_FAULT, OTHER_FAULT])

    client.clear_hms_errors.assert_called_once()
    assert left == [OTHER_FAULT], "only the SD fault is withheld from notification"


def test_no_sd_fault_sends_no_clear():
    client = _client()
    with patch.object(main_module.printer_manager, "get_client", return_value=client):
        left = main_module._auto_clear_sdcard_faults(4, [OTHER_FAULT])

    client.clear_hms_errors.assert_not_called()
    assert left == [OTHER_FAULT]


def test_a_persisting_fault_is_not_re_cleared_on_every_push():
    client = _client()
    with patch.object(main_module.printer_manager, "get_client", return_value=client):
        for _ in range(5):
            main_module._auto_clear_sdcard_faults(4, [SD_FAULT])

    client.clear_hms_errors.assert_called_once()


def test_a_repeat_after_the_interval_is_cleared_again():
    """The case upstream's 10-minute notify window would otherwise swallow."""
    client = _client()
    with (
        patch.object(main_module.printer_manager, "get_client", return_value=client),
        patch.object(
            main_module.time, "monotonic", side_effect=[1000.0, 1000.0 + main_module._SDCARD_CLEAR_MIN_INTERVAL]
        ),
    ):
        main_module._auto_clear_sdcard_faults(4, [SD_FAULT])
        main_module._auto_clear_sdcard_faults(4, [SD_FAULT])

    assert client.clear_hms_errors.call_count == 2


def test_the_throttle_is_per_printer():
    client = _client()
    with patch.object(main_module.printer_manager, "get_client", return_value=client):
        main_module._auto_clear_sdcard_faults(2, [SD_FAULT])
        main_module._auto_clear_sdcard_faults(3, [SD_FAULT])

    assert client.clear_hms_errors.call_count == 2
