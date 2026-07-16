# Bug Fixes Applied (committed to `airthos/bambuddy`)

_Last updated: 2026-07-16. Commit hashes are the source of truth — `git show <hash>` to
verify a fix's current form; this file records intent and root cause, which don't rot as
fast as line numbers do._

## Fix 1: Queue items stuck in "printing" on FINISH (`71facf20`)

**File:** `backend/app/services/bambu_mqtt.py`
**Problem:** `should_trigger_completion` required `_was_running=True`, which meant a
completion was missed if the service restarted during an active print.
**Fix:** Removed the `_was_running` gate for FINISH/FAILED states — completion now
always fires on FINISH/FAILED. IDLE still requires
`_previous_gcode_state == "RUNNING"` (so an explicit abort/cancel is the only IDLE case
that still triggers completion).

## Fix 2: Stale `stg_cur_name` showing "Auto bed leveling" on idle printers (`b30cea7e`)

**Files:** `backend/app/services/bambu_mqtt.py`,
`frontend/src/pages/PrintersPage.tsx`, `frontend/src/pages/StreamOverlayPage.tsx`
**Problem:** a P1S delta-MQTT instance of the class of bug described in
[`printers.md`](printers.md) — `stg_cur` (e.g. stage 1 = "Auto bed leveling") never gets
cleared when a print ends, because the printer doesn't send a reset delta for it.
**Fix (backend):** reset `stg_cur → -1` and `stg = []` in `_update_state()` whenever
`gcode_state` transitions to IDLE/FINISH/FAILED.
**Fix (frontend):** guard the `stg_cur_name` display behind an `isActive` check — only
show the stage name when `state` is `RUNNING`, `PREPARE`, or `PAUSE`.

## Fix 3: Farm script bed setpoint and cooldown threshold (`f142775e`)

**File:** `scripts/farm_process.py`
**Fix:** added `M140 S0` after the M190 cooldown loop, so the bed setpoint reads 0°C
after a farm job instead of a leftover 25°C. Also changed the cooldown release
threshold (argparse default + the hardcoded call in `process_inplace()`) — was 35°C,
**later raised to 40°C on 2026-06-12** in commit `1d5d3c6c` (see
[`features.md`](features.md) item 2).

## Fix 4: Farm script plate_id threading (`481cfa2a`)

**Files:** `scripts/farm_process.py`, `backend/app/services/print_scheduler.py`
**Problem:** the script always wrote `Metadata/plate_1.gcode`, even for queue items on
plate 2 or 3 — the gcode appeared unmodified for anything but plate 1.
**Fix (script):** `write_3mf`, `read_input_3mf`, and `process_inplace` all now accept a
`plate_id` parameter; the entry point accepts an optional second CLI arg.
**Fix (scheduler):** pass `str(item.plate_id or 1)` as the script's second argument.

## Fix 5: Frontend bundle rebuild (`d7cbebc4`, `b30cea7e`)

**Problem:** merging upstream releases kept overwriting `static/assets/index-*.js` with
a bundle missing the fork's farm post-processor checkbox — upstream's committed bundle
silently clobbered the fork's UI feature.
**Fix:** rebuild the frontend locally (`npm run build` in `frontend/`) and commit the
new bundle as part of the merge. **Always diff `static/` after merging upstream** —
this is a recurring failure mode, not a one-time fix.

## Fix 6: `farm_process.py` executable bit (`95009664`)

**Problem:** git doesn't track the executable bit across all clone/copy paths by
default.
**Fix:** `git update-index --chmod=+x scripts/farm_process.py`. If a stash-based deploy
pattern is ever used (normally it isn't — see [`infrastructure.md`](infrastructure.md)),
re-`chmod +x` on the server after.

## Fix 7: Watchdog false-positive exits + HMS dispatch gate (`6f069f8a`)

Root cause discovered 2026-06-09 — queue items 1269/1276/1283/1284 stuck in `printing`
on Airtho 3DP 4 (printer 3). Three distinct bugs combined to cause this:

1. **Watchdog subtask_id false positive.** The P1S echoes back the *new* subtask_id
   from a `project_file` command even when it *rejects* the command (e.g. an active HMS
   error blocks it). The watchdog saw the subtask_id change and treated it as
   confirmation, exiting without reverting the queue item. **Fixed** by adding a
   `status.state != "IDLE"` guard — a subtask_id change only counts as confirmation when
   the printer is not IDLE.
2. **Dispatch-hold had the same false positive.** `_is_dispatch_hold_active()` used the
   same subtask_id logic without the IDLE guard. Fixed identically.
3. **HMS dispatch gate added.** `_is_printer_idle()` now returns `False` when the
   printer has an active fatal/serious HMS error (severity ≤ 2) — Bambu firmware
   silently ignores `project_file` commands while an HMS error is unacknowledged, so
   dispatching into that state was guaranteed to produce another false start. The gate
   auto-unblocks once the error is cleared (manually, or via the auto-clear in
   [`features.md`](features.md) item 1c for the SD-card subset).

**Contributing factor, not fixed:** double-dispatch. If a user hits both "Print Now"
(the library route → `background_dispatch.py`) and "Add to Queue" (the queue route)
for the same printer at roughly the same time, both systems dispatch independently —
`background_dispatch.py` has no awareness of the print scheduler's dispatch state and no
coordination between the two paths. See [`known-issues.md`](known-issues.md).

**Also added:** an `INFO`-level watchdog startup log, so it's observable in logs when a
watchdog spawns and whether it exits early vs. via timeout — this was previously
invisible and made the above three bugs much harder to diagnose.

## Fix 8: Re-dispatch onto a fouled bed (`e878ec77`)

Pushed 2026-06-10, deployed 2026-06-12 (rode along with the 1b deploy). See the
discovery narrative in [`known-issues.md`](known-issues.md) — this used to be listed
there as unfixed; it has since been resolved and is kept here for the fix record.

**Fix:** status-aware `awaiting_plate_clear` gate — `main.py` now raises
`awaiting_plate_clear` only for failed/aborted/cancelled terminal states when
`require_plate_clear=false` (a naturally-completed print already got its plate cleared
by the push-off sequence, so it doesn't need the flag). `_is_printer_idle()` honors this
flag regardless of the `require_plate_clear` setting value. `PrintersPage.tsx` shows the
"Clear Plate" button whenever the flag is set — previously it was gated behind the
`require_plate_clear` setting itself, which would have left no UI path to unblock the
queue when the setting is off. Bundle: `index-2xBfCIGy.js`.

**Net effect:** after any failure/abort/cancel, the queue on that printer now holds
until a human physically clears the bed and clicks Clear Plate — the farm no longer
auto-dispatches the next job onto a bed with a partial part still on it.

## Fix 9: Print Now/Reprint silently skipped the farm post-processor (`95dfeae8`)

**Discovered 2026-07-02** — a batch sent to all three farm printers finished printing
but no part was pushed off the bed, despite "Run farm post-processor" being enabled.

**Root cause:** the queue/scheduler path (`print_scheduler.py`) has always correctly run
`farm_process.py` when `PrintQueueItem.script_processing` is set. But `background_dispatch.py`
— the separate code path behind "Print Now" (library route) and "Reprint" — uploads the
library/archive file straight to the printer via FTP and never calls the post-processor at
all. Worse, the frontend checkbox for it in reprint mode (`ScheduleOptions.scriptProcessing`)
was already wired up and rendered, but `handleSubmit` only spread `printOptions` into the
`api.printLibraryFile`/`api.reprintArchive` calls — `scriptProcessing` lived in a sibling
state object and was silently dropped before the request even left the browser. Neither
`FilePrintRequest` nor `ReprintRequest` had a field for it either.

Net effect: a print dispatched via Print Now or Reprint got the printer's stock
`MACHINE_END_GCODE` — no bed-cooldown loop, no push-off sweep — regardless of the farm loop
setting, because that setting only ever reached the queue path.

**Fix:**
- Extracted the copy → subprocess → swap-file-path logic out of `print_scheduler.py` into
  `backend/app/services/farm_post_process.py` (`apply_farm_post_process()`), so both dispatch
  paths run the exact same code instead of two copies drifting apart.
- Added `script_processing: bool = False` to `FilePrintRequest` (`schemas/library.py`) and
  `ReprintRequest` (`schemas/archive.py`).
- Wired the helper into both `_run_reprint_archive` and `_run_print_library_file` in
  `background_dispatch.py`, right before the FTP upload; `plate_id` resolution was moved
  earlier so the post-processor gets the correct plate. The processed temp file is uploaded
  in place of the original and cleaned up in a `finally` block regardless of outcome — a
  broken/missing script always falls back to the original file rather than blocking the print.
- Fixed the frontend drop: `script_processing: scheduleOptions.scriptProcessing` is now
  explicitly included in both reprint-mode API calls in `PrintModal/index.tsx`.
- New bundle: `index-DddjGGig.js`.

See [`known-issues.md`](known-issues.md) — the *post-processor* half of the "Print Now /
Add to Queue" dispatch-path split is fixed by this; the double-dispatch *race* (both paths
firing for the same printer at once) documented there under Fix 7 is a separate,
still-open issue.

## Fix 10: Repeated dispatch onto a not-ready printer after FTP-upload failure (`c963a894`)

**Discovered 2026-07-14** from server logs — Airtho 3DP 2 (printer id 4) burned four
queue items (1427, 1428, 1429, 1430) as `failed` in consecutive ~30 s cycles, each on an
"FTP upload failed" error, until item 1431 finally succeeded. The printer's own
`auto_cali_for_user_param.gcode` only reported `PRINT COMPLETE` at 13:47:30 — mid-way
through the failed dispatches — so the printer was physically busy (FTP endpoint refusing
uploads) the whole time while reporting a dispatchable `FINISH` state.

**Root cause (two compounding defects):**
1. `_is_printer_idle()` treats `FINISH` as dispatchable, and with `require_plate_clear=false`
   a completed print raises no `awaiting_plate_clear` flag — so a stale/occupied `FINISH`
   printer passes the gate.
2. The bigger one: the anti-double-dispatch cooldown (`_mark_printer_dispatched`, the #1157
   `_dispatch_holds` hold) is only armed *after* a **successful** `start_print`. When the FTP
   upload fails, `_start_print` marked the item `failed` and returned **before** reaching that
   call, so no hold was set. The failed item also isn't in `printing` status, so it never
   seeds `busy_printers` from the DB. Result: every 30 s cycle the printer still read idle,
   had no hold, and got the next pending item dispatched onto it — hammering a not-ready
   printer and consuming queue items one per cycle.

**Fix** (`backend/app/services/print_scheduler.py`, `_start_print`):
- On FTP-upload failure, arm the post-dispatch cooldown with
  `_mark_printer_dispatched(printer_id, None, None)` (a `None` pre_state gives a pure
  time-based hold of `_dispatch_min_cooldown` = 60 s, matching the existing
  disconnected-at-dispatch fallback). This parks the printer so the next cycle skips it.
- Instead of failing the item outright, bounce it back to `pending` and retry up to
  `_max_ftp_dispatch_retries` (=3) times, tracked in an in-memory `_ftp_dispatch_attempts`
  map keyed by queue-item id (mirrors `_dispatch_holds`; resets on restart, which is fine).
  `printer_id`/`archive_id` are preserved so a retry reuses the same printer and the
  already-created archive rather than piling up a fresh archive per attempt. The counter is
  cleared on a successful dispatch and on the final hard failure. Only after the retries are
  exhausted is the item marked `failed` and the failure notification sent.

**Net effect:** a transient FTP/SD glitch or a printer that's briefly busy no longer burns a
run of queue items — the printer is parked for the cooldown and the same item retries a few
cycles later. A genuinely broken printer still fails the item after 3 bounded attempts.

**Tests:** `backend/tests/unit/test_scheduler_ftp_failure_retry.py` — failed upload arms the
dispatch hold; first attempts requeue as `pending` then the last fails with an
"after 3 attempts" message; per-item counter isolation; and `check_queue` skips a printer
left in a dispatch hold.

**Not yet addressed (follow-up):** defect #1 above — a stale `FINISH` counting as dispatchable
(same P1S delta-staleness class as Fix 2). The cooldown fix neutralizes its impact, but
tightening `_is_printer_idle` against stale-FINISH is a separate hardening.

## Fix 11: Reconnect the printer to clear an FTP/SD upload wedge

**Discovered** from the same 2026-07-14 3DP 2 cluster as Fix 10, but a distinct root
cause that Fix 10 did not resolve. Items 1427–1430 each failed on FTP upload; the failure
signature in the logs is diagnostic: the FTP **control connection succeeds every time**
(`FTP connected successfully to 10.1.10.220`), but the `STOR` is rejected with **550 in
~25 ms** — no `FTP data channel ready` line, no data transferred. So the printer accepts
the login but refuses to create the file: its storage/FTP subsystem is wedged while MQTT
still reports a dispatchable state ("genuinely ready, but the upload fails").

**Why Fix 10 wasn't enough.** Fix 10 stops the farm from *burning queue items* (cooldown +
bounce-to-pending), but every retry layer — `bambu_ftp`'s own 4× reconnect-and-retry and
the scheduler's re-dispatch — reopens a **fresh FTP socket** to the **same wedged printer**,
so all of them hit the same 550. In the incident the wedge only cleared after ~2.5 minutes
(item 1431 succeeded), and the reliable manual fix is to **reconnect the printer in the UI**.

**Root cause / mechanism.** Reconnecting the printer (UI "reconnect" → `POST
/{id}/disconnect` + `/connect`, which rebuilds the MQTT client with a fresh `client_id`)
is the same heal path as `force_reconnect_stale_session`: it wipes a stale, unacked
`project_file` command from a half-broken session — the documented #1136 trigger for
`0500_4003` SD R/W on the printer. Clearing that lets the printer's SD/FTP subsystem
accept writes again. A fresh FTP socket alone can't do this; the fix must reconnect the
*printer*, not the FTP connection.

**Fix:**
- `backend/app/services/bambu_ftp.py`: new `UploadRejectedError`. `upload_file` /
  `upload_file_async` gain `raise_on_reject` (default `False` — existing callers such as
  `background_dispatch` and `firmware_update` are unchanged). When set, a permanent 5xx
  rejection of the `STOR` by a *connected* printer raises `UploadRejectedError` instead of
  returning the ambiguous `False`, distinguishing a printer-side wedge from a plain
  connect failure. (Mirrors the existing `FileNotOnPrinterError` + `non_retry_exceptions`
  pattern.)
- `backend/app/services/print_scheduler.py` (`_start_print`): the dispatch upload opts in
  (`raise_on_reject=True`, `non_retry_exceptions=(UploadRejectedError,)` so the reject
  aborts the FTP retry budget immediately). On a reject, before bouncing the item back to
  `pending`, it reconnects the printer (`disconnect_printer` + `connect_printer`) — the
  automated equivalent of the operator's menu reconnect. Safe: the upload failed so no
  print is running, and Fix 10's cooldown gives the fresh session time to settle before the
  next-cycle retry. A plain (non-reject) FTP failure still takes Fix 10's path with no
  reconnect.

**Tests:** `backend/tests/unit/services/test_bambu_ftp.py` (a rejected `STOR` raises with
`raise_on_reject`, still returns `False` without it); `backend/tests/unit/
test_scheduler_ftp_failure_retry.py::TestFtpWedgeReconnect` (a rejected upload reconnects
the printer then requeues; a plain failure does not reconnect).
