# Known Structural Issues (Not Yet Fixed)

_Last updated: 2026-07-01. These are deliberately documented rather than fixed — verify
each is still true against current behavior before assuming it's still open; if you fix
one, move it to [`fixes.md`](fixes.md) with the commit hash instead of deleting it here._

## Printer goes offline mid-print → queue item stuck forever

**Discovered 2026-05-18**, via queue item 1144 on Airtho 3DP 2 (printer 1). Timeline:

- 16:34:28 — printer 1 finishes a previous job, completion fires.
- 16:34:51 — scheduler dispatches item 1144 to printer 1 (plate_id=2).
- 16:35:07 — item 1144 status → `printing`, print command sent.
- 16:36:52 — printer 1's MQTT connection drops with a keep-alive timeout, ~1m45s into
  the print (likely during bed leveling, before the print body actually started).
- 16:42:46 — the BamBuddy service itself restarted (unrelated).
- From restart onward — printer 1 shows `connected=False, state=unknown`. **No MQTT
  reconnect ever fires.** No further log lines for that printer's serial after the
  disconnect.
- Root network cause that time: `10.1.10.220` was unreachable (ping: "Destination Host
  Unreachable") — the printer was physically off or had moved to a different IP.

**The structural gap:** there is no timeout mechanism. If a printer goes offline while
an item is `printing`, that item stays `printing` forever. The scheduler correctly
refuses to dispatch *new* jobs to a `connected=False` printer, but it never auto-fails
the stuck item, so every subsequent queued item behind it is blocked too (this blocked
items 1145–1148 for the rest of that day).

**Resolution path, not yet implemented:**
1. Manual workaround: update the stuck item to `cancelled` in the DB to unblock the
   queue.
2. Structural fix: scheduler logic that, if a printer has been `connected=False` for
   more than N minutes while it has an item in `printing`, auto-transitions that item to
   `failed`/`cancelled` so the queue can proceed (and someone gets notified).

**Related, separate gate:** if `plate_cleared=False` is also true (printer sitting in
FINISH state, plate not physically confirmed clear), the scheduler refuses to dispatch
for that reason too — don't conflate the two; check which gate is actually active before
diagnosing a "stuck queue" report.

## Double-dispatch via "Print Now" + "Add to Queue" racing

Documented as a contributing factor in Fix 7 ([`fixes.md`](fixes.md)). "Print Now"
(library route → `background_dispatch.py`) and "Add to Queue" (the queue/scheduler
route) are independent dispatch paths with **no coordination between them**. If a user
triggers both for the same printer close together, both will attempt to dispatch. This
has not been fixed — `background_dispatch.py` would need to either share the
scheduler's `busy_printers` bookkeeping or gate on the same idle-check the scheduler
uses.

Note: a related but distinct gap in the same two paths — Print Now/Reprint silently
never running the farm post-processor at all — was fixed in Fix 9 (`95dfeae8`). That fix
does not touch dispatch coordination; this race is still open.

## Reprints share one archive, so they share one Sentry recording

> **Worse after the v1.3.1 sync (2026-11-19).** Upstream's archive redesign makes one
> archive with many runs the normal case (`022ea39a1`: a file printing on several
> printers at once is one archive). Seen in production the same day: archive 462 ran on
> 3DP 2, 3 and 4 at once and only 3DP 2 got a recording. Fix: key recordings by run
> (`print_log_entries.id`) instead of archive.

Found 2026-10-28 while fixing the archive-id reuse bug (see Sentry fix 5 in
[`features.md`](features.md)). Several queue items can point at the same
`print_archives` row (archive 434 had queue items 1665–1671 across printers 2, 3 and 4).
Recordings are keyed 1:1 by `archive_id` (UNIQUE), so each later print revives and
appends to the same session: the timeline shows one long block on whichever printer
recorded first. Resolution sketch: key recordings by queue item / print run instead of
archive, or give each dispatch its own archive row. Not fixed — rarer than the id-reuse
case and needs a schema change.

## Farm-mode features that intentionally trade safety for uptime

Not a bug, but worth stating explicitly so it isn't "fixed" by someone unfamiliar with
why it's this way: `require_plate_clear=false` is a real, supported farm-mode
configuration (push-off is expected to clear the plate physically). This is what made
the fouled-bed issue in Fix 8 possible in the first place, and why that fix is
status-aware rather than just re-enabling the plate-clear requirement — turning the
requirement back on would break the lights-out flow this farm depends on.

## Mid-print AMS runout charges the wrong spool

Found 2026-11-19 on 3DP 2 (archive 463, 2026-11-18): slot T3 ran out at layer ~61 and
the AMS switched to T2. The usage tracker charged all 162.3 g to spool 10 (T2) and 0 g to
spool 15 (T3), and dropped ~5 g on a phantom "AMS255-T0" segment. Root cause in
`bambu_mqtt.py`: the tray-change log is seeded at print start from `tray_now`, which is
255 on a P1S before the start-gcode loads filament, so no seed; the start-load of T3 is
then not logged either, because `last_loaded_tray` is already 3 from the previous print.
The log starts at the runout ([(254, 61), (2, 67)]), so `compute_tray_split_grams` gives
layers 0–61 to nobody. 254 is a transient during the switch, treated as a real tray.
**Same code in upstream v1.3.1** (closest upstream issue is the reverse case, #3322).
Resolution sketch: when the log is empty at the first change, seed `(start_tray, 0)` from
the dispatch mapping / `tray_now_at_start`; ignore 254 on printers with no external spool
in use.

