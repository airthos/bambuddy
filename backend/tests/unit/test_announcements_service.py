"""Announcements: verifying the signed feed, and keeping only what applies here.

The feed is signed by the maintainers' registrar. These tests sign their own
feeds with a throwaway key passed in as the trusted one, and check the rules an
install applies: a bad signature, an unknown key or an older serial changes
nothing; a message that does not target this install is not stored; a withdrawn
one disappears with its read markers.
"""

import base64
import hashlib
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy import select

from backend.app.models.announcement import Announcement, AnnouncementRead
from backend.app.models.settings import Settings
from backend.app.services import announcements as svc
from backend.app.services.announcements import FeedRejected, InstallFacts

KEY = Ed25519PrivateKey.generate()
_PUB = KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
KEY_ID = hashlib.sha256(_PUB).hexdigest()[:16]
TRUSTED = {KEY_ID: base64.b64encode(_PUB).decode()}

STABLE_DOCKER = InstallFacts(version="1.2.6", channel="stable", install_type="docker")


def entry(public_id="a1", level="info", target=None, **extra):
    raw = {
        "id": public_id,
        "level": level,
        "published_at": "2026-10-01T12:00:00Z",
        "expires_at": None,
        "texts": {"en": {"title": f"Title {public_id}", "body": "Body"}},
        "link_url": None,
        "target": target or {"min_version": None, "max_version": None, "channels": [], "install_types": []},
    }
    raw.update(extra)
    return raw


def payload(*entries, serial=1):
    return {"format": 1, "serial": serial, "published_at": "2026-10-01T12:00:00Z", "announcements": list(entries)}


def signed(p: dict, key: Ed25519PrivateKey = KEY, key_id: str = KEY_ID) -> bytes:
    """The file exactly as the registrar writes it: pretty, payload as an object."""
    sig = key.sign(svc.canonical(p))
    envelope = {"format": 1, "key_id": key_id, "signature": base64.b64encode(sig).decode(), "payload": p}
    return json.dumps(envelope, indent=2, ensure_ascii=False).encode()


class TestVerify:
    def test_a_correctly_signed_feed_verifies(self):
        p = payload(entry(texts={"en": {"title": "Grüße — 你好", "body": "x"}}))
        assert svc.verify_feed(signed(p), TRUSTED) == p

    def test_tampered_text_is_refused(self):
        content = signed(payload(entry()))
        with pytest.raises(FeedRejected, match="signature"):
            svc.verify_feed(content.replace(b"Title a1", b"Title b1"), TRUSTED)

    def test_another_key_is_refused(self):
        stranger = Ed25519PrivateKey.generate()
        with pytest.raises(FeedRejected, match="signature"):
            svc.verify_feed(signed(payload(entry()), key=stranger), TRUSTED)

    def test_unknown_key_id_is_refused(self):
        with pytest.raises(FeedRejected, match="unknown key"):
            svc.verify_feed(signed(payload(entry()), key_id="0000000000000000"), TRUSTED)

    @pytest.mark.parametrize("content", [b"", b"not json", b"[]", b'{"format": 2}'])
    def test_garbage_is_refused(self, content):
        with pytest.raises(FeedRejected):
            svc.verify_feed(content, TRUSTED)

    @pytest.mark.parametrize("serial", [None, 0, "3", True])
    def test_a_payload_without_a_usable_serial_is_refused(self, serial):
        p = payload(entry())
        p["serial"] = serial
        with pytest.raises(FeedRejected, match="serial"):
            svc.verify_feed(signed(p), TRUSTED)

    def test_the_built_in_key_is_well_formed(self):
        for key_id, public in svc.TRUSTED_KEYS.items():
            raw = base64.b64decode(public)
            assert len(raw) == 32
            assert hashlib.sha256(raw).hexdigest()[:16] == key_id


class TestEntries:
    @pytest.mark.parametrize("public_id", [None, "", "a b", "x" * 65, 7, "../x"])
    def test_unusable_ids_are_dropped(self, public_id):
        assert svc.parse_entry(entry(public_id=public_id)) is None

    def test_no_english_text_is_dropped(self):
        assert svc.parse_entry(entry(texts={"de": {"title": "Hallo", "body": "x"}})) is None

    def test_texts_are_cut_to_length_and_bad_languages_skipped(self):
        e = svc.parse_entry(
            entry(
                texts={
                    "en": {"title": "t" * 500, "body": "b" * 5000, "link_label": "l" * 100},
                    "de": {"title": "", "body": "x"},
                    "fr": "not a dict",
                }
            )
        )
        assert set(e.texts) == {"en"}
        assert len(e.texts["en"]["title"]) == svc.MAX_TITLE
        assert len(e.texts["en"]["body"]) == svc.MAX_BODY
        assert len(e.texts["en"]["link_label"]) == svc.MAX_LINK_LABEL

    def test_unknown_level_is_info(self):
        assert svc.parse_entry(entry(level="apocalyptic")).level == "info"

    @pytest.mark.parametrize(
        "url",
        [
            "http://bambuddy.cool/",
            "https://evil.example/",
            "https://bambuddy.cool.evil.example/",
            "https://user@github.com/",
            "https://github.com:8443/",
            "javascript:alert(1)",
        ],
    )
    def test_links_off_the_allowlist_are_dropped_not_the_message(self, url):
        e = svc.parse_entry(entry(link_url=url))
        assert e is not None and e.link_url is None

    def test_allowed_link_is_kept(self):
        assert svc.parse_entry(entry(link_url="https://wiki.bambuddy.cool/x/")).link_url == (
            "https://wiki.bambuddy.cool/x/"
        )

    def test_times_are_naive_utc(self):
        e = svc.parse_entry(entry(expires_at="2026-11-01T02:00:00+02:00"))
        assert e.expires_at == datetime(2026, 11, 1, 0, 0)


class TestTargeting:
    @pytest.mark.parametrize(
        "version, low, high, shown",
        [
            ("1.2.6", None, None, True),
            ("1.2.6", "1.2.6", None, True),
            ("1.2.6", "1.2.7", None, False),
            ("1.2.6", None, "1.2.5", False),
            ("1.2.6b1", "1.2.6", None, False),  # a beta is older than its release
            ("1.2.6b1", None, "1.2.6", True),
            ("1.2.6b3", "1.2.6b2", "1.2.6b3", True),
        ],
    )
    def test_version_range(self, version, low, high, shown):
        facts = InstallFacts(version=version, channel="stable", install_type="docker")
        target = {"min_version": low, "max_version": high}
        assert svc.targets({"target": target}, facts) is shown

    def test_channel(self):
        beta_only = {"target": {"channels": ["beta"]}}
        assert not svc.targets(beta_only, STABLE_DOCKER)
        assert svc.targets(beta_only, InstallFacts("1.2.6", "beta", "docker"))

    def test_install_type(self):
        windows_only = {"target": {"install_types": ["windows"]}}
        assert not svc.targets(windows_only, STABLE_DOCKER)
        assert svc.targets(windows_only, InstallFacts("1.2.6", "stable", "windows"))

    def test_a_malformed_target_shows_nothing(self):
        assert not svc.targets({"target": "everyone"}, STABLE_DOCKER)


async def _stored(db) -> list[str]:
    return sorted((await db.execute(select(Announcement.public_id))).scalars().all())


async def _serial(db) -> str | None:
    return (await db.execute(select(Settings.value).where(Settings.key == svc.SERIAL_KEY))).scalar_one_or_none()


class TestApply:
    @pytest.mark.asyncio
    async def test_stores_only_what_targets_this_install(self, db_session):
        p = payload(
            entry("everyone"),
            entry("beta", target={"channels": ["beta"]}),
            entry("windows", target={"install_types": ["windows"]}),
            entry("broken", texts={}),
        )
        assert await svc.apply_payload(db_session, p, STABLE_DOCKER) == 1
        await db_session.commit()
        assert await _stored(db_session) == ["everyone"]
        assert await _serial(db_session) == "1"

    @pytest.mark.asyncio
    async def test_withdrawn_upstream_goes_with_its_read_markers(self, db_session):
        await svc.apply_payload(db_session, payload(entry("keep"), entry("drop")), STABLE_DOCKER)
        await db_session.commit()
        assert await svc.mark_read(db_session, "drop", None)
        await db_session.commit()

        await svc.apply_payload(db_session, payload(entry("keep"), serial=2), STABLE_DOCKER)
        await db_session.commit()
        assert await _stored(db_session) == ["keep"]
        assert (await db_session.execute(select(AnnouncementRead))).scalars().all() == []

    @pytest.mark.asyncio
    async def test_an_edit_keeps_the_read_state(self, db_session):
        await svc.apply_payload(db_session, payload(entry("a1")), STABLE_DOCKER)
        await db_session.commit()
        await svc.mark_read(db_session, "a1", None)
        await db_session.commit()
        edited = entry("a1", texts={"en": {"title": "Fixed typo", "body": "Body"}})
        await svc.apply_payload(db_session, payload(edited, serial=2), STABLE_DOCKER)
        await db_session.commit()
        [item] = await svc.list_for(db_session, None)
        assert item["texts"]["en"]["title"] == "Fixed typo"
        assert item["read"] is True

    @pytest.mark.asyncio
    async def test_an_older_serial_is_refused_and_changes_nothing(self, db_session):
        await svc.apply_payload(db_session, payload(entry("new"), serial=5), STABLE_DOCKER)
        await db_session.commit()
        with pytest.raises(FeedRejected, match="older"):
            await svc.apply_payload(db_session, payload(entry("old"), serial=4), STABLE_DOCKER)
        await db_session.rollback()
        assert await _stored(db_session) == ["new"]
        assert await _serial(db_session) == "5"

    @pytest.mark.asyncio
    async def test_the_same_serial_again_is_fine(self, db_session):
        await svc.apply_payload(db_session, payload(entry("a1"), serial=3), STABLE_DOCKER)
        await svc.apply_payload(db_session, payload(entry("a1"), serial=3), STABLE_DOCKER)
        await db_session.commit()
        assert await _stored(db_session) == ["a1"]


class TestReadState:
    @pytest.mark.asyncio
    async def test_expired_ones_are_history(self, db_session):
        past = (datetime.now(timezone.utc) - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        future = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        p = payload(entry("gone", expires_at=past), entry("live", expires_at=future), entry("forever"))
        await svc.apply_payload(db_session, p, STABLE_DOCKER)
        await db_session.commit()
        listed = {i["id"]: i["archived"] for i in await svc.list_for(db_session, None)}
        assert listed == {"gone": True, "live": False, "forever": False}

    @pytest.mark.asyncio
    async def test_archived_in_the_feed_is_history_even_without_an_expiry(self, db_session):
        await svc.apply_payload(db_session, payload(entry("old", archived=True)), STABLE_DOCKER)
        await db_session.commit()
        [item] = await svc.list_for(db_session, None)
        assert item["archived"] is True

    @pytest.mark.asyncio
    async def test_history_dropped_by_the_feed_is_deleted(self, db_session):
        past = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        await svc.apply_payload(db_session, payload(entry("old", expires_at=past, archived=True)), STABLE_DOCKER)
        await db_session.commit()
        await svc.apply_payload(db_session, payload(serial=2), STABLE_DOCKER)
        await db_session.commit()
        assert await svc.list_for(db_session, None) == []

    @pytest.mark.asyncio
    async def test_reading_twice_with_auth_off_records_once(self, db_session):
        await svc.apply_payload(db_session, payload(entry("a1")), STABLE_DOCKER)
        await db_session.commit()
        assert await svc.mark_read(db_session, "a1", None)
        await db_session.commit()
        assert await svc.mark_read(db_session, "a1", None)
        await db_session.commit()
        assert len((await db_session.execute(select(AnnouncementRead))).scalars().all()) == 1

    @pytest.mark.asyncio
    async def test_unknown_id_is_not_marked(self, db_session):
        assert not await svc.mark_read(db_session, "nope", None)


class TestRefresh:
    @pytest.mark.asyncio
    async def test_switched_off_fetches_nothing(self, db_session):
        db_session.add(Settings(key=svc.ENABLED_KEY, value="false"))
        await db_session.commit()
        with patch.object(svc, "_download", AsyncMock()) as download:
            assert await svc.refresh(db_session) is None
        download.assert_not_called()

    @pytest.mark.asyncio
    async def test_a_good_feed_is_stored(self, db_session):
        with (
            patch.object(svc, "_download", AsyncMock(return_value=signed(payload(entry("a1"))))),
            patch.object(svc, "TRUSTED_KEYS", TRUSTED),
            patch.object(svc, "install_facts", AsyncMock(return_value=STABLE_DOCKER)),
        ):
            assert await svc.refresh(db_session) == 1
        assert await _stored(db_session) == ["a1"]

    @pytest.mark.asyncio
    async def test_open_pages_are_told_only_when_the_feed_moved_on(self, db_session):
        feed = signed(payload(entry("a1"), serial=3))
        with (
            patch.object(svc, "_download", AsyncMock(return_value=feed)),
            patch.object(svc, "TRUSTED_KEYS", TRUSTED),
            patch.object(svc, "install_facts", AsyncMock(return_value=STABLE_DOCKER)),
            patch("backend.app.core.websocket.ws_manager.broadcast", AsyncMock()) as broadcast,
        ):
            await svc.refresh(db_session)
            broadcast.assert_awaited_once_with({"type": "announcements_changed"})
            # The same feed again: nothing new to tell anyone.
            await svc.refresh(db_session)
            assert broadcast.await_count == 1

    @pytest.mark.asyncio
    async def test_a_bad_feed_keeps_the_last_good_list(self, db_session):
        with (
            patch.object(svc, "TRUSTED_KEYS", TRUSTED),
            patch.object(svc, "install_facts", AsyncMock(return_value=STABLE_DOCKER)),
        ):
            with patch.object(svc, "_download", AsyncMock(return_value=signed(payload(entry("a1"))))):
                await svc.refresh(db_session)
            forged = signed(payload(serial=9), key=Ed25519PrivateKey.generate())
            with patch.object(svc, "_download", AsyncMock(return_value=forged)):
                assert await svc.refresh(db_session) is None
        assert await _stored(db_session) == ["a1"]

    @pytest.mark.asyncio
    async def test_offline_is_quiet_and_harmless(self, db_session):
        import httpx

        with patch.object(svc, "_download", AsyncMock(side_effect=httpx.ConnectError("offline"))):
            assert await svc.refresh(db_session) is None
