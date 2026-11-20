"""Announcements from the Bambuddy maintainers: fetch, verify, keep what applies.

Bambuddy fetches one file, ``feed.json``, from the public
``maziggy/bambuddy-notifications`` repo on raw.githubusercontent.com -- the host
the update check already talks to. No Bambuddy server is contacted and nothing
about this install is sent: whether a message applies here (version range,
channel, install type) is decided below, locally.

The file is written by the maintainers' registrar and signed with Ed25519:

    {"format": 1, "key_id": "...", "signature": "<base64>", "payload": {...}}

The signature covers ``canonical(payload)``. A file that does not verify against
a key in ``TRUSTED_KEYS`` is ignored, so neither a copy of the repo nor anyone in
the middle can make Bambuddy show a message. The payload's ``serial`` only goes
up; a feed older than one already accepted is refused, so an old signed file
cannot be re-served to bring back a withdrawn message.

The feed is the full current list. On every accepted fetch the stored set is
replaced: a message withdrawn upstream disappears here with its read markers.
Any failure keeps the last good list.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import random
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.config import APP_VERSION
from backend.app.models.announcement import Announcement, AnnouncementRead
from backend.app.models.settings import Settings

logger = logging.getLogger(__name__)

FEED_URL = "https://raw.githubusercontent.com/maziggy/bambuddy-notifications/main/feed.json"
FEED_FORMAT = 1

# key_id (first 16 hex of sha256 of the raw public key) -> base64 raw public key.
# A list so the key can be rotated: ship the new key next to the old one first.
TRUSTED_KEYS: dict[str, str] = {
    "d70b3bf207fdfd59": "uQqUAYrInmXQ1nIwOIY/95L7tD5o/HZMmZfhAlULJ/w=",
}

# Where a message may link to. The registrar refuses anything else too; this is
# the side that counts.
LINK_HOSTS = ("github.com", "bambuddy.cool")

LEVELS = ("info", "important", "critical")
MAX_FEED_BYTES = 512 * 1024
MAX_TITLE = 120
MAX_BODY = 2000
MAX_LINK_LABEL = 40

FETCH_INTERVAL_SECONDS = 6 * 3600
FETCH_JITTER_SECONDS = 30 * 60
# Let startup settle before the first fetch.
FIRST_FETCH_DELAY_SECONDS = 60

ENABLED_KEY = "announcements_enabled"
ALL_USERS_KEY = "announcements_all_users"
# Internal state, never part of the settings API.
SERIAL_KEY = "announcements_feed_serial"
LAST_FETCH_KEY = "announcements_last_fetch"


class FeedRejected(Exception):
    """The fetched file is not a feed this install accepts. Nothing changes."""


# ---- verification -------------------------------------------------------------------


def canonical(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def verify_feed(content: bytes, trusted_keys: dict[str, str] | None = None) -> dict:
    """The payload of a correctly signed feed, or FeedRejected."""
    keys = TRUSTED_KEYS if trusted_keys is None else trusted_keys
    try:
        envelope = json.loads(content)
    except (ValueError, UnicodeDecodeError) as exc:
        raise FeedRejected("not JSON") from exc
    if not isinstance(envelope, dict) or envelope.get("format") != FEED_FORMAT:
        raise FeedRejected("unknown feed format")
    public = keys.get(str(envelope.get("key_id")))
    if public is None:
        raise FeedRejected(f"signed with an unknown key ({envelope.get('key_id')!r})")
    payload = envelope.get("payload")
    if not isinstance(payload, dict):
        raise FeedRejected("no payload")
    try:
        signature = base64.b64decode(str(envelope.get("signature")), validate=True)
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public)).verify(signature, canonical(payload))
    except (ValueError, InvalidSignature) as exc:
        raise FeedRejected("signature does not verify") from exc
    if payload.get("format") != FEED_FORMAT:
        raise FeedRejected("unknown payload format")
    serial = payload.get("serial")
    if not isinstance(serial, int) or isinstance(serial, bool) or serial < 1:
        raise FeedRejected("no serial")
    if not isinstance(payload.get("announcements"), list):
        raise FeedRejected("no announcement list")
    return payload


# ---- what this install is ------------------------------------------------------------


@dataclass(frozen=True)
class InstallFacts:
    version: str
    channel: str  # stable | beta
    install_type: str  # docker | native | ha_addon | windows


def _version_key(version: str) -> tuple:
    """Sortable form that puts a release above its own betas (1.2.6 > 1.2.6b3)."""
    from backend.app.api.routes.updates import parse_version

    parsed = parse_version(version)
    major, minor, patch, micro = (parsed + (0, 0, 0, 0))[:4]
    is_prerelease = parsed[4] if len(parsed) > 4 else 0
    prerelease_num = parsed[5] if len(parsed) > 5 else 0
    return (major, minor, patch, micro, 1 - is_prerelease, prerelease_num)


def _install_type() -> str:
    from backend.app.api.routes import updates

    if updates._is_windows_installer_install():
        return "windows"
    if updates._is_ha_addon():
        return "ha_addon"
    if updates._is_docker_environment():
        return "docker"
    return "native"


async def install_facts(db: AsyncSession) -> InstallFacts:
    beta_setting = (
        await db.execute(select(Settings.value).where(Settings.key == "include_beta_updates"))
    ).scalar_one_or_none()
    # Beta testers are the installs that asked for betas, and the ones running one.
    prerelease = bool(re.search(r"[a-zA-Z]", APP_VERSION.lstrip("v")))
    beta = prerelease or (beta_setting or "").lower() == "true"
    return InstallFacts(version=APP_VERSION, channel="beta" if beta else "stable", install_type=_install_type())


def targets(entry: dict, facts: InstallFacts) -> bool:
    target = entry.get("target") or {}
    if not isinstance(target, dict):
        return False
    try:
        here = _version_key(facts.version)
        low, high = target.get("min_version"), target.get("max_version")
        if low and here < _version_key(str(low)):
            return False
        if high and here > _version_key(str(high)):
            return False
    except (TypeError, ValueError):
        return False
    channels = target.get("channels") or []
    if channels and facts.channel not in channels:
        return False
    install_types = target.get("install_types") or []
    return not (install_types and facts.install_type not in install_types)


# ---- one entry, defensively ---------------------------------------------------------


def link_allowed(url: str) -> bool:
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host or parts.username or parts.password:
        return False
    if port not in (None, 443):
        return False
    return any(host == allowed or host.endswith("." + allowed) for allowed in LINK_HOSTS)


def _parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _clean_texts(texts: object) -> dict[str, dict[str, str]] | None:
    """Plain strings, cut to length. None when there is no usable English text."""
    if not isinstance(texts, dict):
        return None
    cleaned: dict[str, dict[str, str]] = {}
    for lang, text in texts.items():
        if not isinstance(lang, str) or len(lang) > 10 or not isinstance(text, dict):
            continue
        title, body = text.get("title"), text.get("body")
        if not isinstance(title, str) or not isinstance(body, str) or not title.strip() or not body.strip():
            continue
        entry = {"title": title.strip()[:MAX_TITLE], "body": body.strip()[:MAX_BODY]}
        label = text.get("link_label")
        if isinstance(label, str) and label.strip():
            entry["link_label"] = label.strip()[:MAX_LINK_LABEL]
        cleaned[lang] = entry
    return cleaned if "en" in cleaned else None


@dataclass
class Entry:
    public_id: str
    level: str
    texts: dict[str, dict[str, str]]
    link_url: str | None
    published_at: datetime | None
    expires_at: datetime | None


def parse_entry(raw: object) -> Entry | None:
    """One feed entry, or None if it can't be shown safely. Never raises."""
    if not isinstance(raw, dict):
        return None
    public_id = raw.get("id")
    if not isinstance(public_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", public_id):
        return None
    level = raw.get("level") if raw.get("level") in LEVELS else "info"
    texts = _clean_texts(raw.get("texts"))
    if texts is None:
        return None
    link = raw.get("link_url")
    link = link if isinstance(link, str) and link_allowed(link) else None
    published_at = _parse_time(raw.get("published_at"))
    expires_at = _parse_time(raw.get("expires_at"))
    # History is whatever has expired; the feed's ``archived`` flag says the same
    # thing for messages the registrar kept after their expiry. One flagged but
    # still in date by this install's clock is history anyway: expire it now.
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if raw.get("archived") is True and (expires_at is None or expires_at > now):
        expires_at = now
    return Entry(
        public_id=public_id,
        level=level,
        texts=texts,
        link_url=link,
        published_at=published_at,
        expires_at=expires_at,
    )


# ---- store ---------------------------------------------------------------------------


async def _get(db: AsyncSession, key: str) -> str | None:
    return (await db.execute(select(Settings.value).where(Settings.key == key))).scalar_one_or_none()


async def _set(db: AsyncSession, key: str, value: str) -> None:
    from backend.app.core.db_dialect import upsert_setting

    await upsert_setting(db, Settings, key, value)


async def is_enabled(db: AsyncSession) -> bool:
    return (await _get(db, ENABLED_KEY) or "true").lower() != "false"


async def apply_payload(db: AsyncSession, payload: dict, facts: InstallFacts) -> int:
    """Replace the stored announcements with the ones in ``payload`` that apply here.

    Refuses (FeedRejected) a serial below the highest already accepted. The same
    serial again is the same feed fetched twice, and is fine. Returns how many are
    stored. The caller commits.
    """
    serial = payload["serial"]
    seen = int(await _get(db, SERIAL_KEY) or 0)
    if serial < seen:
        raise FeedRejected(f"serial {serial} is older than {seen}, already accepted")

    wanted: dict[str, Entry] = {}
    for raw in payload["announcements"]:
        entry = parse_entry(raw)
        if entry is not None and targets(raw, facts):
            wanted[entry.public_id] = entry

    existing = {a.public_id: a for a in (await db.execute(select(Announcement))).scalars().all()}
    gone = [a.id for pid, a in existing.items() if pid not in wanted]
    if gone:
        # Read markers first: SQLite enforces no foreign keys unless asked to, so
        # ON DELETE CASCADE alone would leave them behind.
        await db.execute(delete(AnnouncementRead).where(AnnouncementRead.announcement_id.in_(gone)))
        await db.execute(delete(Announcement).where(Announcement.id.in_(gone)))
    for pid, entry in wanted.items():
        row = existing.get(pid) or Announcement(public_id=pid)
        row.level = entry.level
        row.texts = json.dumps(entry.texts, ensure_ascii=False)
        row.link_url = entry.link_url
        row.published_at = entry.published_at
        row.expires_at = entry.expires_at
        if pid not in existing:
            db.add(row)
    await _set(db, SERIAL_KEY, str(max(serial, seen)))
    return len(wanted)


async def _download() -> bytes:
    # No version and no install identity in the request: the generic agent says
    # what is asking, nothing about which install.
    headers = {"User-Agent": "Bambuddy-Announcements", "Cache-Control": "no-cache"}
    async with (
        httpx.AsyncClient(timeout=15, follow_redirects=False) as client,
        client.stream("GET", FEED_URL, headers=headers) as response,
    ):
        if response.status_code != 200:
            raise FeedRejected(f"HTTP {response.status_code}")
        chunks: list[bytes] = []
        size = 0
        async for chunk in response.aiter_bytes():
            size += len(chunk)
            if size > MAX_FEED_BYTES:
                raise FeedRejected("larger than the feed is allowed to be")
            chunks.append(chunk)
        return b"".join(chunks)


async def refresh(db: AsyncSession) -> int | None:
    """Fetch, verify and store. Returns how many apply here, or None if nothing changed.

    Never raises for a network problem or a bad feed -- those are logged and the
    last good list stays. A switched-off install fetches nothing.
    """
    if not await is_enabled(db):
        return None
    seen_before = int(await _get(db, SERIAL_KEY) or 0)
    try:
        content = await _download()
        payload = verify_feed(content)
        count = await apply_payload(db, payload, await install_facts(db))
    except FeedRejected as exc:
        await db.rollback()
        logger.warning("Announcements feed ignored: %s", exc)
        return None
    except httpx.HTTPError as exc:
        await db.rollback()
        # Offline and air-gapped installs land here every time; not worth a warning.
        logger.info("Announcements feed not fetched: %s", type(exc).__name__)
        return None
    await _set(db, LAST_FETCH_KEY, datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    await db.commit()
    logger.info("Announcements feed #%s: %d for this install", payload["serial"], count)
    if payload["serial"] > seen_before:
        await _tell_open_pages()
    return count


async def _tell_open_pages() -> None:
    """Have every open Bambuddy page re-read the list, so a new message's dot and
    banner appear without a reload. The event carries nothing: each page asks
    GET /announcements, which answers by who is asking."""
    from backend.app.core.websocket import ws_manager

    try:
        await ws_manager.broadcast({"type": "announcements_changed"})
    except Exception:  # A page that misses it catches up on its own poll.
        logger.debug("announcements_changed broadcast failed", exc_info=True)


# ---- read state ----------------------------------------------------------------------


async def list_for(db: AsyncSession, user_id: int | None) -> list[dict]:
    """Every stored announcement, newest first, with this user's read state.

    ``archived`` marks history: messages past their expiry, which the panel lists
    under "Earlier" and which never count as unread or raise a banner. The feed
    decides how much history there is; a message it drops is deleted here.
    """
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = (
        (await db.execute(select(Announcement).order_by(Announcement.published_at.desc(), Announcement.id.desc())))
        .scalars()
        .all()
    )
    reader = AnnouncementRead.user_id.is_(None) if user_id is None else AnnouncementRead.user_id == user_id
    read_ids = set((await db.execute(select(AnnouncementRead.announcement_id).where(reader))).scalars().all())
    result = []
    for a in rows:
        try:
            texts = json.loads(a.texts)
        except (TypeError, ValueError):
            continue
        result.append(
            {
                "id": a.public_id,
                "level": a.level,
                "texts": texts,
                "link_url": a.link_url,
                "published_at": a.published_at.isoformat() + "Z" if a.published_at else None,
                "expires_at": a.expires_at.isoformat() + "Z" if a.expires_at else None,
                "archived": a.expires_at is not None and a.expires_at <= now,
                "read": a.id in read_ids,
            }
        )
    return result


async def mark_read(db: AsyncSession, public_id: str, user_id: int | None) -> bool:
    """Record that this user read it. False if there is no such announcement."""
    announcement = (
        await db.execute(select(Announcement).where(Announcement.public_id == public_id))
    ).scalar_one_or_none()
    if announcement is None:
        return False
    reader = AnnouncementRead.user_id.is_(None) if user_id is None else AnnouncementRead.user_id == user_id
    # Checked rather than left to the unique constraint: NULL user_ids never
    # collide in one, so the auth-off row would be duplicated on every click.
    already = (
        await db.execute(select(AnnouncementRead.id).where(AnnouncementRead.announcement_id == announcement.id, reader))
    ).first()
    if already is None:
        db.add(AnnouncementRead(announcement_id=announcement.id, user_id=user_id))
    return True


# ---- background loop -----------------------------------------------------------------

_task: asyncio.Task | None = None


async def _loop() -> None:
    from backend.app.core.database import async_session

    await asyncio.sleep(FIRST_FETCH_DELAY_SECONDS)
    while True:
        try:
            async with async_session() as db:
                await refresh(db)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Announcements refresh failed")
        await asyncio.sleep(FETCH_INTERVAL_SECONDS + random.uniform(0, FETCH_JITTER_SECONDS))


def start() -> None:
    global _task
    if _task is None:
        _task = asyncio.create_task(_loop())


def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        _task = None
