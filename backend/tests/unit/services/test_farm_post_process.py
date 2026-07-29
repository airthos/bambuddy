"""Unit tests for the shared farm post-processor helper (`farm_post_process.py`).

This module is the single place both the print queue scheduler and the
background dispatch service ("Print Now" / "Reprint") invoke the configured
`post_process_script`. Before it existed, Print Now/Reprint silently skipped
the script even with "Run farm post-processor" checked, because those paths
uploaded the library/archive file as-is (see docs/airtho/known-issues.md).
"""

import asyncio
import stat
import sys
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.services.farm_post_process import apply_farm_post_process

# The real code invokes the configured script path directly (relying on a
# shebang + the executable bit, exactly how scripts/farm_process.py runs on
# the Ubuntu server — see docs/airtho known-issues re: the executable bit).
# That only works on POSIX; skip the real-subprocess cases on Windows dev
# boxes rather than fake a shebang, matching this repo's Linux-only CI target.
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="relies on POSIX shebang execution")


def _make_temp_3mf(gcode_content: str = "G28\nG1 X0 Y0\nM400\n") -> Path:
    fd, name = tempfile.mkstemp(suffix=".3mf")
    import os

    os.close(fd)
    path = Path(name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Metadata/plate_1.gcode", gcode_content)
        zf.writestr("Metadata/slice_info.config", "<config></config>")
    return path


def _make_script(content: str) -> Path:
    fd, name = tempfile.mkstemp(suffix=".sh")
    import os

    os.close(fd)
    path = Path(name)
    path.write_text(content)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)
    return path


def _mock_db_with_settings(settings: dict):
    """A minimal AsyncSession stand-in whose execute() returns a Settings-shaped
    object (or None) keyed by which `Settings.key == "..."` the query filters on.
    Keys not present in `settings` resolve to None (i.e. the field's own default)."""
    db = MagicMock()

    async def side_effect(stmt):
        result = MagicMock()
        try:
            compiled = stmt.compile(compile_kwargs={"literal_binds": False})
            param_values = list(compiled.params.values())
        except Exception:
            param_values = []
        for key, val in settings.items():
            if key in param_values:
                result.scalar_one_or_none.return_value = MagicMock(value=val) if val is not None else None
                return result
        result.scalar_one_or_none.return_value = None
        return result

    db.execute = AsyncMock(side_effect=side_effect)
    return db


def _mock_db_with_setting(value: str | None):
    """A minimal AsyncSession stand-in for just the post_process_script setting.
    farm_cooldown_temp resolves to None (falls back to its 35 default)."""
    return _mock_db_with_settings({"post_process_script": value})


class TestApplyFarmPostProcess:
    @pytest.mark.asyncio
    async def test_not_configured_returns_none(self):
        db = _mock_db_with_setting(None)
        source = _make_temp_3mf()
        try:
            result = await apply_farm_post_process(db, source, 1, log_label="test")
            assert result is None
        finally:
            source.unlink(missing_ok=True)

    @pytest.mark.asyncio
    async def test_blank_script_path_returns_none(self):
        db = _mock_db_with_setting("   ")
        source = _make_temp_3mf()
        try:
            result = await apply_farm_post_process(db, source, 1, log_label="test")
            assert result is None
        finally:
            source.unlink(missing_ok=True)

    @posix_only
    @pytest.mark.asyncio
    async def test_successful_script_returns_new_processed_copy(self):
        source = _make_temp_3mf("ORIGINAL\n")
        script = _make_script(
            "#!/usr/bin/env python3\n"
            "import sys, zipfile, tempfile, shutil\n"
            "from pathlib import Path\n"
            "p = Path(sys.argv[1])\n"
            "assert sys.argv[2] == '2'\n"
            "with zipfile.ZipFile(p, 'r') as zf:\n"
            "    content = zf.read('Metadata/plate_1.gcode').decode()\n"
            "content += '; PROCESSED\\n'\n"
            "with tempfile.NamedTemporaryFile(delete=False, suffix='.3mf') as t:\n"
            "    tmp = Path(t.name)\n"
            "with zipfile.ZipFile(tmp, 'w') as zf:\n"
            "    zf.writestr('Metadata/plate_1.gcode', content)\n"
            "shutil.move(tmp, p)\n"
        )
        db = _mock_db_with_setting(str(script))
        try:
            result = await apply_farm_post_process(db, source, 2, log_label="test")

            assert result is not None
            assert result != source
            assert result.exists()
            with zipfile.ZipFile(result, "r") as zf:
                content = zf.read("Metadata/plate_1.gcode").decode()
            assert "ORIGINAL" in content
            assert "; PROCESSED" in content

            # Original must never be touched.
            with zipfile.ZipFile(source, "r") as zf:
                assert zf.read("Metadata/plate_1.gcode").decode() == "ORIGINAL\n"

            result.unlink(missing_ok=True)
        finally:
            source.unlink(missing_ok=True)
            script.unlink(missing_ok=True)

    @posix_only
    @pytest.mark.asyncio
    async def test_failing_script_returns_none_and_cleans_up_temp(self):
        source = _make_temp_3mf("ORIGINAL\n")
        script = _make_script("#!/usr/bin/env python3\nimport sys\nsys.exit(1)\n")
        db = _mock_db_with_setting(str(script))
        try:
            result = await apply_farm_post_process(db, source, 1, log_label="test")
            assert result is None
            with zipfile.ZipFile(source, "r") as zf:
                assert zf.read("Metadata/plate_1.gcode").decode() == "ORIGINAL\n"
        finally:
            source.unlink(missing_ok=True)
            script.unlink(missing_ok=True)

    @pytest.mark.asyncio
    async def test_timeout_returns_none_and_kills_process(self, monkeypatch):
        source = _make_temp_3mf()
        db = _mock_db_with_setting("/some/script")

        killed = {"called": False}

        class FakeProc:
            returncode = None

            async def communicate(self):
                raise asyncio.TimeoutError()

            def kill(self):
                killed["called"] = True

        async def fake_create_subprocess_exec(*args, **kwargs):
            return FakeProc()

        monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
        try:
            result = await apply_farm_post_process(db, source, 1, log_label="test")
            assert result is None
            assert killed["called"] is True
        finally:
            source.unlink(missing_ok=True)

    @pytest.mark.asyncio
    async def test_unexpected_exception_never_propagates(self, monkeypatch):
        """A broken script/environment must not block dispatch — always return None."""
        source = _make_temp_3mf()
        db = _mock_db_with_setting("/some/script")

        async def fake_create_subprocess_exec(*args, **kwargs):
            raise OSError("executable not found")

        monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
        try:
            result = await apply_farm_post_process(db, source, 1, log_label="test")
            assert result is None
        finally:
            source.unlink(missing_ok=True)

    @pytest.mark.asyncio
    async def test_plate_id_none_defaults_to_1(self, monkeypatch):
        source = _make_temp_3mf()
        db = _mock_db_with_setting("/some/script")

        captured_args = {}

        class FakeProc:
            returncode = 0

            async def communicate(self):
                return (b"", b"")

        async def fake_create_subprocess_exec(*args, **kwargs):
            captured_args["args"] = args
            return FakeProc()

        monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
        try:
            result = await apply_farm_post_process(db, source, None, log_label="test")
            assert result is not None
            assert captured_args["args"][2] == "1"
            result.unlink(missing_ok=True)
        finally:
            source.unlink(missing_ok=True)

    @pytest.mark.asyncio
    async def test_cooldown_temp_read_from_settings_and_passed_to_script(self, monkeypatch):
        source = _make_temp_3mf()
        db = _mock_db_with_settings({"post_process_script": "/some/script", "farm_cooldown_temp": "42"})

        captured_args = {}

        class FakeProc:
            returncode = 0

            async def communicate(self):
                return (b"", b"")

        async def fake_create_subprocess_exec(*args, **kwargs):
            captured_args["args"] = args
            return FakeProc()

        monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
        try:
            result = await apply_farm_post_process(db, source, 1, log_label="test")
            assert result is not None
            assert captured_args["args"][2] == "1"
            assert captured_args["args"][3] == "42"
            result.unlink(missing_ok=True)
        finally:
            source.unlink(missing_ok=True)
