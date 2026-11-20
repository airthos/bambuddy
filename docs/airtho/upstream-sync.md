# Upstream Sync Record + Fork Inventory

_Last updated: 2026-11-19 (merge of upstream **v1.3.1** into the fork, branch
`merge/upstream-v1.3.1`). Re-generate the inventory below with
`git diff v1.3.1 HEAD --stat -- . ':!static' ':!docs/airtho'` after the next sync._

## Sync history

| Date | Upstream tag | Notes |
|---|---|---|
| 2026-08-05 | v1.2.5.2 | From v0.2.4.3. Fixes 2 (frontend half), 7 (IDLE guard) and 9 dropped for upstream equivalents. |
| 2026-11-19 | v1.3.1 | 1,478 upstream commits. See "What this sync changed" below. |

## What this sync changed in the fork

Weighed every fork change against the upstream commits since v1.2.5.2. Outcome:

**Dropped — upstream now does it (better):**
- **Archive "Remove Duplicates"** (`POST /archives/deduplicate`, `DeduplicateModal.tsx`,
  `test_archives_deduplicate.py`). It hard-deleted every archive sharing a content hash
  except the oldest. Upstream's archive redesign P2 (`926957f62`, `aa8d90671`) *merges*
  duplicates into the oldest instead — runs, queue items, spool usage, photos and
  videos move over, the merged ids keep resolving via an alias. Use Archives → Merge
  duplicates.
- **Fix 10 — FTP failure cooldown + bounded retry** (`_mark_printer_dispatched` on upload
  failure, `dispatch_attempts` bump, `test_scheduler_ftp_failure_retry.py`). Upstream
  #3210/#3409 (`9a5ab06ed`, `bb5a362c0`) keeps the job in the queue on any refused
  upload and backs the printer off 5 min → doubling → 1 h, without spending the
  start-watchdog budget. Same goal, finer-grained (per failure kind, with a reason shown
  on the queue row and one "job waiting" notification per outage).
- **Fix 11's `UploadRejectedError` / `raise_on_reject` in `bambu_ftp.py`.** Upstream #2899
  (`70ee53464`) now reports *why* every upload failed (`FtpFailure`/`FtpFailureKind`,
  550 → `NOT_FOUND`), so the fork's own exception is redundant. The *behaviour* of Fix 11
  was kept — see below.
- **Empty-slot auto-remap trigger** in `_ensure_ams_mapping` (cached mapping pointing at a
  removed spool). Upstream #2799's `_stored_mapping_conflict` recomputes a mapping that
  names a tray the printer no longer has. The fork keeps only the RFID `remain==0` part
  of its check (`_validate_ams_mapping`), which upstream's fit check doesn't cover.

- **Fix 1 — completion on any FINISH/FAILED** (removed 2026-11-20, after the inventory
  below flagged it). Upstream's #3310 reconnect reconcile closes a print that finished
  during a restart, by `subtask_id`; Fix 1 on top would double-fire that completion.
- **Sentry live Grid view** (`CameraGridTile.tsx`, removed 2026-11-20). Upstream's Cam Wall
  (`/camwall`, or Printers → Cam wall) is the live grid; the Sentry page now shows the
  timeline only and links to it.
- **`StreamOverlayPage.tsx` comment** — reverted to upstream verbatim.

**Re-implemented on top of upstream's new code:**
- **Fix 11 (reconnect on a wedged STOR)** now keys off upstream's
  `FtpFailureKind.NOT_FOUND`: reconnect the printer, then hand the job to upstream's
  `_requeue_after_upload_refused`. Bounded by `FTP_WEDGE_RECONNECT_ATTEMPTS = 3` refusals
  in a row, after which the item fails as upstream does — upstream deliberately fails a
  550 because it can also be the file's own path, which would otherwise requeue forever.
  Tests: `test_scheduler_ftp_wedge_reconnect.py` (on upstream's #3210 harness).
- **SD-card HMS auto-clear (features 1c)** moved *ahead of* upstream's notified-fault
  bookkeeping into `_auto_clear_sdcard_faults()` in `main.py`. Upstream #3226/#3486 now
  report a fault only once per 10-minute window and remember it across restarts; left
  inside the notification loop, a repeat SD fault would never be cleared and the
  scheduler's HMS dispatch gate would hold the queue. Throttled to one clear per
  printer per 30 s. Tests: `test_sdcard_hms_auto_clear.py` (the feature had none before).
- **Plate-clear gate (Fix 8)**: upstream rewrote the raise in `on_print_complete`; the
  fork's "completed + require_plate_clear=false → don't raise" rule re-applied there.
  `_pinned_hold_reason` now says "Waiting for plate confirmation" whenever the flag is
  up (upstream only did so with the setting on). Frontend: upstream already dropped the
  `connected` condition on the Clear Plate button (#2864); the fork drops the
  `requirePlateClear` condition as before.
- **Sentry restart recovery** (`on_print_running_observed`) now finds the archive through
  upstream's per-printer run (`_archive_of_open_run`) instead of
  `PrintArchive.printer_id == X AND status == 'printing'`, which names whichever printer
  started the archive's latest run once archives are shared.
- **Farm post-processor options** now ride on every queue-creation path the new Print
  modal has (cross-model variants, "queue as separate jobs", normal, edit) and are
  copied by order clones (`print_batch.CLONED_SETTING_COLUMNS`).
- **Sentry start hook** (`_maybe_start_sentry_recording`) now swallows and logs its own
  errors, so a recorder failure can no longer cut short the rest of print-start handling
  (timelapse baseline, usage-tracker mapping). Caught by upstream's
  `test_print_start_assigns_printer_id_to_vp_archive.py` during this sync.
- **Settings keys** registered in upstream's new `_BOOL/_INT_SETTING_KEYS` sets; Sentry
  tab added to the new data-driven settings tab list; `api.getCameraStreamUrl` restored
  (upstream removed it as unused in `460c11ca3`; the Sentry live view uses it).

**Kept as-is (upstream still has no equivalent):** farm post-processor + `farm_process.py`,
prefer-recently-used spool + sequential wrap + persistence, Sentry recording/snapshots,
HMS dispatch gate (Fix 7.3), Fix 2 backend
stg_cur reset, archive-delete recording purge, camera fan-out pinned subscribers.

**Not done here, flagged:** upstream's archive redesign makes "one archive, many runs"
the normal case (a file printing on several printers is one archive — `022ea39a1`). The
Sentry recorder is still keyed 1:1 by `archive_id`, so concurrent or repeated prints of
one file share — or fail to get — a recording (seen 2026-11-19: three printers ran
archive 462, only 3DP 2 recorded). Re-keying recordings by run (`print_log_entries.id`)
is the structural fix. See [`known-issues.md`](known-issues.md).

## Verification (2026-11-19)

The 210 backend test files covering the merged areas (scheduler, queue, completion, HMS,
plate-clear, settings, archives, FTP upload) were run on this branch and on pure v1.3.1
on the same Windows machine: 24 failures + 3 errors are common to both (Windows path
separators, POSIX-only fixtures), and the two failures only this branch had were fixed
(the Sentry guard above, and the deliberate 550 change). Fork-specific suites and the
frontend page tests pass; `test_bambu_ftp.py` needs the Docker harness (real FTP/TLS
sockets). The remaining ~8k backend tests were not compared — run the full suite in
Docker before deploying.

## Full inventory: fork vs upstream v1.3.1

Every place the fork's code differs from upstream after this sync, grouped by feature,
with an honest note on whether it is still earning its keep. "Removal candidate" means
upstream now has something close enough that the fork piece is worth re-evaluating.

### A. Farm post-processor (features 1, 1a, 2) — core, keep
| File | Change |
|---|---|
| `scripts/farm_process.py` (+786) | The end-sequence rewriter: bed cooldown loop, flex, push-off sweep, plate-aware |
| `backend/app/services/farm_post_process.py` (+131) | Copy → run script → swap file, shared by dispatch |
| `backend/app/services/print_scheduler.py` | Calls it before upload; marks `end_gcode_injected` for upstream's #2547 finish photo |
| `backend/app/models/print_queue.py`, `schemas/print_queue.py`, `routes/print_queue.py` | `script_processing`, `script_options` (+ `FarmScriptOptions` ranges) |
| `backend/app/services/print_batch.py` | Clones carry the two columns |
| `backend/app/core/database.py` | Two `ALTER TABLE print_queue` migrations |
| `backend/app/schemas/settings.py`, `routes/settings.py` | `post_process_script`, `farm_cooldown_temp` |
| `frontend/.../PrintModal/ScheduleOptions.tsx`, `index.tsx`, `types.ts`, `api/client.ts` | Checkbox + options panel, sent on every create/edit path |
| `frontend/src/pages/SettingsPage.tsx` | Farm Post-Processor Script card |

Upstream alternative: `gcode_snippets` / "Inject G-code" (static per-model start/end
text). It cannot do what `farm_process.py` does (strip the stock end block, plate-aware
rewrite, per-print parameters), so not a substitute.

### B. Prefer recently-used spool (features 1b, 1d) — keep while farm runs non-RFID spools
| File | Change |
|---|---|
| `print_scheduler.py` | `_prefer_recent_sort_key` (sequential wrap), `_match_filaments_to_slots` params, `_compute_ams_mapping_for_printer` reads live/persisted tray, `_ensure_ams_mapping(prefer_recent=)` recompute trigger, `check_queue` reads the setting once per tick |
| `printer_manager.py` (+58) | `active_spool_tray` get/set/persist/load |
| `models/printer.py`, `database.py` | `printers.active_spool_tray` column |
| `main.py` | Captures `last_loaded_tray` on every status push; loads at startup |
| Settings (schema, route keys, SettingsPage toggle, en.ts) | `prefer_recently_used_filament` |

Upstream alternative: `prefer_lowest_filament` (no-op on remain=-1 spools) and #2804
nearest-colour pick. Neither drains one spool before the next. Removal candidate only if
the farm moves to RFID spools.

### C. Sentry mode (features 3) — largest fork surface
| File | Change |
|---|---|
| `services/camera_recorder.py` (+595), `camera_frame_pack.py` (+336), `camera_interval_capture.py` (+131), `camera_recording_purge.py` (+132) | Recording, chunk packing/export, interval snapshots, retention |
| `models/camera_recording.py` (+83), `routes/camera_recordings.py` (+357) | Tables + API |
| `services/camera_fanout.py` (+69) | Pinned subscribers that survive `force_shutdown` |
| `services/archive.py` (+10) | Purge recording on archive delete (id-reuse fix) |
| `main.py` | 7 start hooks, completion hook, startup reconcile, schedulers, public-path allowlist |
| Frontend: `CamerasPage.tsx`, `camera-timeline/CameraTimelineView.tsx` (+1263), `App.tsx`, `Layout.tsx`, SettingsPage Sentry tab, `client.ts`, `en.ts`, `utils/date.ts` (H:MM:SS) | Page, timeline player, settings |

Upstream alternatives now: **Cam Wall** (`/camwall`, live grid with temps/ETA/controls —
the fork's Grid view was removed in its favour), per-print printer timelapse
(each run keeps its own since P1b), finish photos from an in-print frame bank (#2547).
None records a scrubbable per-job camera history, so the recorder/timeline still has no
upstream equivalent. (The fork's Grid view was removed 2026-11-20 for Cam Wall.) Known gap: archive-keyed sessions vs. shared archives (above).

### D. HMS handling — keep, small
| File | Change |
|---|---|
| `main.py` | `_HMS_SDCARD_AUTO_CLEAR` + `_auto_clear_sdcard_faults` (features 1c) |
| `print_scheduler.py` `_is_printer_idle` | Block dispatch on severity ≤ 2 HMS (Fix 7.3) |

Upstream has a dispatch *watchdog* that fails an item when the printer refuses the start
(`start_refusal`, `HMS_MQTT_VERIFY_FAILED`), but no pre-dispatch HMS gate. **Removal
candidate to test:** with upstream's watchdog the gate mostly saves a wasted upload; if
that's acceptable, Fix 7.3 can go — but then the SD auto-clear stops mattering too.

### E. Plate-clear semantics (Fix 8) — keep (farm safety)
`main.py` (don't raise on completed when `require_plate_clear=false`),
`print_scheduler.py` (gate honoured regardless of setting; hold reason),
`PrintersPage.tsx` (button + pill shown whenever flag set). Upstream's model is
"setting on → always gate, off → never gate"; neither fits a lights-out farm that must
still stop after a failure.

### F. MQTT state fixes — removal candidates
| File | Change | Status |
|---|---|---|
| ~~`bambu_mqtt.py` (Fix 1)~~ | ~~Completion on any first FINISH/FAILED~~ | **Removed 2026-11-20** — upstream's #3310 reconcile covers it. |
| `bambu_mqtt.py` (Fix 2) | Reset `stg_cur`/`stg` on IDLE/FINISH/FAILED | Upstream names unnamed stages "Preparing" (`73e0787bf`) but still doesn't reset. Keep (tiny). |

### G. FTP (Fix 11) — keep, now ~25 lines
`print_scheduler.py`: reconnect on `NOT_FOUND`, bounded. Everything else is upstream.

### H. Scheduler test/behaviour reconciliations
`test_scheduler_clear_plate.py`, `test_scheduler_backup_gate.py`,
`test_scheduler_ams_mapping.py`, `test_scheduler_db_busy_seed.py`,
`test_scheduler_upload_requeue_3210.py` (550 case moved to the fork test),
`test_scheduler_pinned_waiting_reason_3074.py` (plate-flag reason with the setting off),
`test_upload_failure_reason_2899.py` (550 wording pinned with the reconnect budget spent),
`frontend SettingsPage.test.tsx` (sidebar order includes the Sentry `cameras` item),
`test_print_lifecycle.py`, `test_archives_api.py`, `test_airtho_mqtt_fixes.py` — encode
fork behaviour; they go when the behaviour goes.

### I. Docs/tooling (no runtime effect)
`AGENTS.md`, `CLAUDE.md`, `docs/airtho/`, `skills/farm-*`, `CHANGELOG.md` fork block.
