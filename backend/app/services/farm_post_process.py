"""Shared farm post-processor invocation.

Runs the user-configured `post_process_script` (normally `scripts/farm_process.py`,
which injects the bed-cooldown + push-off end sequence) against a copy of a sliced
3MF before it's uploaded to a printer.

Used by both the print queue scheduler (`print_scheduler.py`) and the background
dispatch service (`background_dispatch.py` — "Print Now" and "Reprint"), so a print
gets the same farm-loop end sequence no matter which dispatch path started it.
Before this existed, Print Now/Reprint silently skipped the post-processor even
with "Run farm post-processor" enabled, because those paths upload the library/
archive file as-is — see docs/airtho/known-issues.md.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.settings import Settings

logger = logging.getLogger(__name__)

_TIMEOUT_SECONDS = 120


async def _read_post_process_script_setting(db: AsyncSession) -> str | None:
    result = await db.execute(select(Settings).where(Settings.key == "post_process_script"))
    setting = result.scalar_one_or_none()
    return setting.value if setting else None


async def apply_farm_post_process(
    db: AsyncSession,
    file_path: Path,
    plate_id: int | None,
    *,
    log_label: str,
) -> Path | None:
    """Run the configured farm post-processor script against a copy of file_path.

    Returns the path to a new, processed 3MF temp file on success — the caller
    owns it and must delete it once done (e.g. after upload). Returns None if
    the script isn't configured, fails, or times out; callers should fall back
    to the original file_path in that case. Never raises — a broken script
    must not block a print from starting.
    """
    script_path = await _read_post_process_script_setting(db)
    if not script_path or not script_path.strip():
        logger.warning("%s: script_processing enabled but post_process_script not configured", log_label)
        return None

    with tempfile.NamedTemporaryFile(delete=False, suffix=".3mf") as tmp:
        script_out_path = Path(tmp.name)
    shutil.copy2(file_path, script_out_path)

    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            script_path.strip(),
            str(script_out_path),
            str(plate_id or 1),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=_TIMEOUT_SECONDS)
        if proc.returncode == 0:
            logger.info("%s: post_process_script applied", log_label)
            return script_out_path
        script_out_path.unlink(missing_ok=True)
        logger.warning(
            "%s: post_process_script failed (rc=%s): %s",
            log_label,
            proc.returncode,
            stderr.decode(errors="replace"),
        )
        return None
    except asyncio.TimeoutError:
        if proc is not None:
            proc.kill()
        script_out_path.unlink(missing_ok=True)
        logger.warning("%s: post_process_script timed out, using original", log_label)
        return None
    except Exception as e:
        script_out_path.unlink(missing_ok=True)
        logger.warning("%s: post_process_script error, using original: %s", log_label, e)
        return None
