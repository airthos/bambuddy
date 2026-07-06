# Custom Features Added in This Fork

_Last updated: 2026-07-01. Verify file paths and line references against current code —
the codebase moves faster than this doc._

## 1. Farm Post-Processor Script Hook

- `script_processing` bool column on `print_queue` — per-queue-item toggle to run a farm
  post-processor script before FTP upload.
- `post_process_script` setting (a path on the server) — configured in
  Settings → Workflow → Farm Post-Processor Script.
- Script interface: receives the temp `.3mf` path + `plate_id` as args, modifies the
  file in-place, exits 0 on success.
- Frontend checkbox "Run farm post-processor" in
  `frontend/src/components/modals/PrintModal.tsx`.
- The concrete script used is `scripts/farm_process.py` — see item 2 below.

## 1b. "Prefer Recently-Used Spool" Filament Preference

Commit `7a953506`, deployed 2026-06-12.

- **Why:** the farm runs non-BBL spools with no RFID, so AMS reports `remain=-1` and the
  existing upstream `prefer_lowest_filament` feature is a no-op for those slots. Goal:
  when multiple AMS slots hold a compatible filament, keep feeding the slot the printer
  last used, so one spool finishes before the next starts (instead of round-robin
  wasting partial spools).
- **Setting:** `prefer_recently_used_filament` bool (Settings → filament tracking, next
  to Prefer Lowest). A separate toggle; takes precedence over `prefer_lowest_filament`
  when both are on.
- **Signal used:** the printer's `PrinterState.last_loaded_tray` (falls back to
  `tray_now`) — this survives the unload→255 transition at print end and follows the AMS
  through a mid-print runout auto-fallback, so it reliably points at the spool
  physically in use. It resets on service restart, at which point behavior falls back to
  slot-position order until the first completion re-establishes it (no persistence
  across restarts by design — see the "reverted" note in 1c for why nothing more elaborate was added here either).
- **Backend:** `print_scheduler.py` — `_prefer_recent_sort_key`;
  `_match_filaments_to_slots` gained `prefer_recent`/`preferred_tray` params (applied at
  both sort call sites, including the `tray_info_idx` subset);
  `_compute_ams_mapping_for_printer` reads the setting + `last_loaded_tray`. **Key
  detail:** `check_queue` forces `needs_mapping=True` when the setting is on, at both
  dispatch sites, so a cached/baked mapping can't defeat it — non-RFID slots never
  validate as "empty," so the normal auto-remap path wouldn't otherwise fire.
- **Trade-off, explicit:** while this setting is on, a slot manually chosen in the Print
  modal and then queued gets overridden at dispatch time. This is intentional for the
  lights-out farm path; "Print Now" (immediate dispatch, not queued) is unaffected.
- **Frontend:** toggle in `SettingsPage.tsx` (i18n keys `preferRecentlyUsedFilament` /
  `...Desc` in `en.ts`), field in `api/client.ts`. Preview parity in
  `useFilamentMapping.ts` was deliberately **not** done — optional, since the farm/queue
  dispatch path is backend-authoritative and the preview is cosmetic.
- **Tests:** `TestPreferRecentlyUsedFilament` in `test_scheduler_ams_mapping.py` (7
  cases including auto-switch and precedence-over-`prefer_lowest`).
- Bundle at time of ship: `index-BDZcMu3C.js`.

## 1c. SD-Card HMS Auto-Clear

Added 2026-06-29. **Not yet committed/deployed as of last update** — check
`git log -- backend/app/main.py` / `git status` before assuming it's live; it may exist
as a local uncommitted diff.

- **Why:** transient SD/MicroSD read/write HMS errors (especially `0500_C010`) spam a
  notification on every MQTT push and, worse, block the dispatch gate (any HMS at
  severity ≤2 counts as "not idle" in `_is_printer_idle`) until a human clicks "Clear
  HMS." On unattended farm hardware that's a stuck queue for no real reason — the fault
  is transient and self-clearing.
- **Rejected first draft — read this before proposing anything similar:** an earlier
  version of this feature added a whole parallel system: a scheduler state machine
  (`_recover_sdcard_for_printer` / `recover_sdcard_now`), a per-printer cooldown/lockout
  dict, a `force_reconnect` escalation path, a new `auto_recover_sdcard_errors` settings
  toggle plus frontend control, and an `HMSError.short_code` property. **Brendan
  rejected this outright** — the ask was to implement it the way BamBuddy already works,
  not bolt on new machinery. The entire draft was reverted via `git checkout`.
- **What actually shipped: a single ~28-line additive diff in `backend/app/main.py`,
  nothing else.** It mirrors the existing `_HMS_FAILURE_REASONS` /
  `_HMS_NOTIFICATION_SUPPRESS` module-level-set pattern that was already in the file:
  - A module-level set `_HMS_SDCARD_AUTO_CLEAR` (next to `_HMS_FAILURE_REASONS`, ~line
    412): `0500_C010`, `0500_402F`, `0500_800E`, `0500_8013`, `0300_800E`. Codes that
    need physical intervention (no card / full / write-protected) are deliberately
    excluded so those still notify a human.
  - Inside the **existing** HMS handler `on_printer_status_change`'s per-error loop,
    right after `short_code` is computed and before the description/suppress check: if
    `short_code in _HMS_SDCARD_AUTO_CLEAR`, call the **existing**
    `printer_manager.get_client(printer_id).clear_hms_errors()` once — guarded by a
    `sdcard_cleared` flag, since `clean_print_error` acknowledges the whole error list at
    once — then `continue` to skip the notification for that error.
- **Explicitly not added:** no reconnect logic, no settings toggle, no scheduler
  changes, no frontend changes, no new tests (the analogous
  `_HMS_NOTIFICATION_SUPPRESS` behavior has none either — consistency with existing
  test coverage, not an oversight). The existing `_notified_hms_errors` debounce
  naturally limits clears to once per newly-seen occurrence; clearing the error unblocks
  the dispatch gate on its own via the existing severity check.
- **Lesson, stated plainly for future work in this area:** match BamBuddy's existing
  patterns and architecture. Don't invent a parallel subsystem, extra hooks, or a new
  toggle unless specifically asked for one. Grep for the nearest existing analogous
  feature first.
- **Known pre-existing, unrelated test failures** as of this feature's development:
  `TestPrePrintFailureCompletion::test_initial_failed_does_not_trigger_completion` and
  `test_idle_to_failed_does_not_trigger_completion` in `test_bambu_mqtt.py`. These encode
  the *pre-Fix-1* "FAILED shouldn't trigger completion" expectation that Fix 1 (commit
  `71facf20`, see [`fixes.md`](fixes.md)) deliberately removed. If you see these failing,
  it's not this feature's fault — but also verify they haven't been fixed/removed since,
  rather than assuming this note is still accurate.

## 2. `scripts/farm_process.py` — Farm Loop End Sequence

Cherry-picked from `airthos/print-farm`, adds the farm's end-of-print loop sequence.

- **What it does:** strips the stock `MACHINE_END_GCODE_START` block and injects: a bed
  cooldown loop (`M190` at **35°C** — raised to 40°C on 2026-06-12 (commit `1d5d3c6c`),
  then reverted back to 35°C on 2026-07-02 (commit `910c5319`) after the farm reported the
  plates weren't cooling enough at 40°C to release cleanly; 40 iterations) → `M140 S0`
  (clears the bed setpoint so the UI shows 0°C, not a leftover 25°C) → a bed-flex sequence
  (Z204↔Z224, three cycles, now at a deliberately slow **300 mm/min** as of 2026-07-02 —
  was 600 mm/min, same as every other Z move in the script; slowing just the flex gives
  the plate more time to bend against the clip instead of snapping through, for a cleaner
  release — controlled by the `flex_speed` param / `--flex-speed` CLI flag) → a part
  push-off sweep across center/right/left lanes, all at **2000 mm/min** since 2026-06-12
  (commit `509f5e02` — the center lane used to run at a "slow" 300 mm/min and now matches
  the other lanes; controlled by the `push_speed` param / `--push-speed` CLI flag).
  Note: the "40" in the `M190` loop is the **iteration count**, not the temperature —
  the temperature is the separate `cooldown_temp` param.
- **Plate-aware:** reads/writes `Metadata/plate_{N}.gcode` and
  `Metadata/plate_{N}.gcode.md5` for the correct plate — see Fix 4 in
  [`fixes.md`](fixes.md) for why this needed a dedicated fix.
- **Call signature:** `farm_process.py <path_to_3mf> [plate_id]` — `plate_id` defaults
  to `1`.
- **Archive behavior:** BamBuddy's archive stores the **original, unmodified** library
  file. The farm script only ever runs on a temp copy that gets FTP'd to the printer.
  So the archive viewer showing unprocessed gcode is expected, not a bug — don't
  "fix" this without understanding why it's intentional (archives are meant to preserve
  the source-of-truth file).

## 3. Sentry Mode — Per-Job Camera Recording + Interval Snapshots

_Added 2026-07-02 through 2026-07-06._

Two independent camera-logging features, both off by default, configured in
Settings → Sentry:

### 3a. Per-job recording
Records camera frames for each print job — from dispatch through completion plus a
configurable post-roll — rather than 24/7. Sessions are keyed 1:1 to `print_archives`
rows. Settings: `sentry_enabled`, `sentry_retention_days` (default 7), `sentry_pre_roll_minutes`
(default 1 — **best-effort only**, see limitation below), `sentry_post_roll_seconds`
(default 60).

**Architecture:**
- `backend/app/models/camera_recording.py` — `CameraRecordingSession` (one row per
  archive) + `CameraRecordingFrame` (frame index). Frames are packed into one
  `.framelog` file per session (`data/camera_recordings/{printer_id}/{archive_id}.framelog`,
  format `[4B length][8B ts_ms][JPEG bytes]`), not one file per frame — at farm scale
  that would be hundreds of thousands of files/week.
- `backend/app/services/camera_recorder.py` — subscribes to the printer's existing
  `MjpegBroadcaster` (`camera_fanout.py`) as a **pinned** subscriber, so it can never
  be evicted by an unrelated viewer's "stop camera" call, and live viewers can still
  use the camera while a recording is active (they share the same upstream connection).
  Runs a watchdog that closes the session (`status='orphaned'`) if the print never
  reaches `RUNNING` or the printer disconnects for too long — required so a pinned
  subscriber can never wedge camera access to a printer forever. Also retries with
  backoff (5s, up to ~5 min) if the camera upstream disconnects mid-print instead of
  giving up permanently — this was a real production bug (see Fix log below).
- Hooked into `on_print_start` (3 call sites), `on_print_running_observed`
  (restart-recovery), and `on_print_complete` in `main.py`, plus
  `reconcile_on_startup()` for backend restarts mid-print.
- `backend/app/services/camera_recording_purge.py` — retention sweeper, respects a
  per-session `keep_forever` flag.
- `backend/app/api/routes/camera_recordings.py` — list/frames/frame-image/keep-forever/
  delete/storage/clear-all.

**Known limitation:** true pre-roll (frames from *before* the camera connection opens)
isn't physically possible without holding every printer's camera connection open 24/7,
which defeats the point of event-triggered recording — nothing is watching an idle
printer between jobs, so there's nothing to buffer from. `sentry_pre_roll_minutes` is
honored on a best-effort basis only (recording starts as early in the dispatch pipeline
as possible, not literally N minutes ahead).

### 3b. Interval snapshots
Independent, much simpler feature: captures one snapshot per active printer on a fixed
schedule (5/10/30/60 min, configurable), regardless of print state — a basic ambient
check-in even when nothing is printing. Settings: `sentry_interval_enabled`,
`sentry_interval_minutes` (default 30), `sentry_interval_retention_days` (default 30).
Storage is tiny by comparison — a few GB/month for the whole farm even at 5-minute
intervals — since it's sparse sampling, not continuous capture.

- `backend/app/models/camera_recording.py::CameraIntervalSnapshot` — one row + one
  JPEG file per snapshot (file count is never a concern at this sampling rate).
- `backend/app/services/camera_interval_capture.py` — polling loop; reuses
  `try_get_active_buffered_frame()`/`is_stream_active()` (the same pattern the
  existing manual-snapshot route uses) to avoid opening a second camera connection
  when a live viewer or the per-job recorder is already using it.
- Settings UI includes a live storage estimate (client-side calculation, not a real
  usage query) so the interval/retention tradeoff is visible before committing to it.

### Frontend
- Sidebar nav: "Cameras" → "Sentry" (Radar icon). Grid/Detail toggle lives on that page;
  Detail is a per-printer timeline (24h mini-previews, scrubbable job timeline,
  frame-by-frame player with speed control).
- Player preloads every frame into the browser's HTTP cache as soon as a recording is
  selected (`new Image()` per frame) — without this the first playthrough visibly
  flickers/stalls because `<img src>` only starts fetching a frame the instant playback
  reaches it.

### Fixes applied post-launch (for the historical record)
1. **Settings not persisting** — the Settings page's debounced auto-save uses a
   hardcoded field list for both change-detection and the save payload; the `sentry_*`
   fields were never added to either, so toggling the switch updated local UI state
   only and was silently discarded on refresh.
2. **Frames returning 401** — two separate causes, both now fixed: (a) the frame-image
   endpoint required full session auth but loads via `<img src>`, which can't send
   `Authorization` headers — switched to the same stream-token scheme the live camera
   view uses; (b) a **global auth middleware** in `main.py` blocks every `/api/*`
   request unless the path matches an allowlist (`PUBLIC_API_PATTERNS`) — the existing
   camera stream/snapshot routes are on it, the new frame/snapshot-image routes weren't.
   Added narrow patterns (`/frames/`, `/snapshots/`) — deliberately not the broader
   `/recordings/`, which would have also exempted the keep-forever/delete endpoints
   from real permission checks.
3. **Recording captured ~12 frames then went dark for the rest of a 37-minute print** —
   the pump exited silently and permanently on the first camera disconnect (caused by a
   backend restart during deploy), while the session stayed marked "active" until the
   print naturally completed. Root-caused live against production logs/DB. Fixed with
   the reconnect-with-backoff logic described above.
4. **`reconcile_on_startup()` UNIQUE-constraint crash** — it called `start_session()`
   without `resume_row=`, which tried to `INSERT` a `CameraRecordingSession` row that
   already existed. Caught by a dedicated regression test before it hit production.
