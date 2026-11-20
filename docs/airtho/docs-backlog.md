# Documentation backlog

A running list of processes and setups that still need documentation written. Add an
item when something gets built or changed and no doc covers it yet. Remove it (or move
it to **Done**) once the doc exists, and link to where the doc lives.

Where docs go (see the IT procedures convention):
- **IT procedure** (.docx in OneDrive `IT - Documents/Procedures/`) covers how a person
  runs, maintains or fixes something. Keep it general and point to this knowledge base
  for the specifics.
- **This knowledge base** (`docs/airtho/`) covers what was set up on the server and how
  it differs from upstream BamBuddy.

## Open

### SharePoint folder sync to airtho-server (`odsync`)
- **Added:** 2026-11-20
- **Status of the work:** the sync went live 2026-11-20 (Entra app
  `airtho-server-onedrive-sync`, scope checked with negative tests). It is linked in
  BamBuddy as the read-only External folder `airtho-manufacturing`. New files only
  appear in BamBuddy after a **Scan**, because there is no automatic rescan.
- **What it is:** a one-way rclone sync from one SharePoint folder to
  `/srv/airtho-manufacturing`. It uses an app-only Entra identity
  (`Files.SelectedOperations.Selected`, read on one folder) with a client secret.
  BamBuddy links the folder as a read-only External folder.
- **Docs needed:**
  - [ ] IT procedure: creating or re-creating the Entra app and the folder grant
    through Graph Explorer, and what to do if the folder moves or is replaced.
  - [ ] IT procedure: **rotating the client secret**. The current secret is stored in
    the IT Bitwarden collection and is valid 24 months from 2026-11-20 (**expires
    2028-11-20**). Steps: create the new secret in Entra, update Bitwarden, run
    `sudo odsync-set-secret`, run `odsync@check`, then delete the old secret. Name an
    owner for the calendar reminder.
  - [ ] IT procedure: checking the sync is healthy and troubleshooting it
    (`systemctl status odsync.timer`, `journalctl -u odsync@sync`, `odsync@check`,
    restoring files from `/var/lib/odsync/trash`, the `--max-delete 50` stop). The
    timer runs a sync 1 minute after the last one finishes.
  - [ ] Knowledge base: an `infrastructure.md` entry for the server pieces. These are
    the `odsync` user, the `airtho-mfg` group (with `bambuddy` in it),
    `/srv/airtho-manufacturing`, `/var/lib/odsync/rclone.conf`, the encrypted
    credential, the units, and the rclone version (v1.76+ is required for
    OneDrive/SharePoint before 2027-04-01).
  - [ ] Knowledge base: `BAMBUDDY_EXTERNAL_ROOTS` in `/opt/bambuddy/.env` and why the
    External folder must stay read-only (the one-way sync would overwrite or delete
    anything written there).
- **Source material:** `print-farm-exploration/onedrive-sync-plan.md` (decisions,
  options considered, step-by-step setup).

## Done

_Nothing yet._
