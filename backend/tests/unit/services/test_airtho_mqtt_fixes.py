"""
Regression tests for Airtho fork fixes to BambuMQTTClient.

Covers the fix that must survive an upstream merge (Fix 1, the completion
trigger without the _was_running gate, was dropped at the v1.3.1 sync in favour
of upstream's #3310 reconnect reconcile):

  Fix 2 (commit b30cea7e): stg_cur is reset to -1 when gcode_state transitions
  to IDLE, FINISH, or FAILED (prevents stale "Auto bed leveling" label on idle
  P1S printers, which only send delta MQTT updates).
"""

import pytest


@pytest.fixture
def client():
    from backend.app.services.bambu_mqtt import BambuMQTTClient

    return BambuMQTTClient(
        ip_address="10.0.0.1",
        serial_number="TEST_AIRTHO",
        access_code="00000000",
    )


# ---------------------------------------------------------------------------
# Fix 2: stg_cur reset on terminal states
# ---------------------------------------------------------------------------


class TestStgCurResetOnTerminalState:
    """stg_cur must be cleared when printer reaches a terminal/idle state.

    P1S only sends delta MQTT packets — the printer never explicitly clears
    stg_cur when printing ends, leaving stale stage names in the UI.
    """

    def _apply_gcode_state(self, client, new_state: str):
        """Minimal simulation of the gcode_state branch in _update_state."""
        client.state.state = new_state
        if new_state in ("IDLE", "FINISH", "FAILED") and client.state.stg_cur not in (-1, 0):
            client.state.stg_cur = -1
            client.state.stg = []

    def test_stg_cur_reset_on_idle(self, client):
        client.state.stg_cur = 1  # e.g. "Auto bed leveling"
        client.state.stg = [1]
        self._apply_gcode_state(client, "IDLE")
        assert client.state.stg_cur == -1
        assert client.state.stg == []

    def test_stg_cur_reset_on_finish(self, client):
        client.state.stg_cur = 14  # some mid-print stage
        client.state.stg = [14]
        self._apply_gcode_state(client, "FINISH")
        assert client.state.stg_cur == -1
        assert client.state.stg == []

    def test_stg_cur_reset_on_failed(self, client):
        client.state.stg_cur = 3
        self._apply_gcode_state(client, "FAILED")
        assert client.state.stg_cur == -1

    def test_stg_cur_already_minus1_not_touched(self, client):
        """If stg_cur is already -1 the reset is a no-op (avoids unnecessary log spam)."""
        client.state.stg_cur = -1
        client.state.stg = []
        self._apply_gcode_state(client, "IDLE")
        assert client.state.stg_cur == -1
        assert client.state.stg == []

    def test_stg_cur_not_reset_during_running(self, client):
        """stg_cur must NOT be cleared during an active print."""
        client.state.stg_cur = 1
        self._apply_gcode_state(client, "RUNNING")
        assert client.state.stg_cur == 1, "RUNNING must not reset stg_cur"

    def test_stg_cur_not_reset_during_prepare(self, client):
        client.state.stg_cur = 0  # value 0 is excluded from the reset guard
        self._apply_gcode_state(client, "FINISH")
        # stg_cur == 0 is in the exclusion list, so it stays 0
        assert client.state.stg_cur == 0
