"""Who sees announcements, and per-user read state.

Administrators see them; other signed-in users only when
``announcements_all_users`` is on. With authentication off, the person running
Bambuddy sees them. Anyone else gets ``visible: false`` and an empty list. Those
who may see them get ``visible: true`` even with nothing published, because the
sidebar entry is there for them either way.
"""

import json
import secrets

import pytest
from httpx import AsyncClient

from backend.app.models.announcement import Announcement
from backend.app.models.settings import Settings

URL = "/api/v1/announcements"
_FIXTURE_PW = "Aa1!" + secrets.token_urlsafe(12)  # pragma: allowlist secret


async def _seed(db, *public_ids: str, level: str = "important") -> None:
    for pid in public_ids:
        db.add(
            Announcement(
                public_id=pid,
                level=level,
                texts=json.dumps({"en": {"title": f"T {pid}", "body": "B"}, "de": {"title": "D", "body": "B"}}),
            )
        )
    await db.commit()


async def _setting(db, key: str, value: str) -> None:
    db.add(Settings(key=key, value=value))
    await db.commit()


async def _get(client: AsyncClient, headers: dict | None = None) -> dict:
    r = await client.get(URL, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def _items(client: AsyncClient, headers: dict | None = None) -> list[dict]:
    return (await _get(client, headers))["announcements"]


async def _admin(client: AsyncClient, username: str) -> dict:
    await client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": username, "admin_password": _FIXTURE_PW},
    )
    login = await client.post("/api/v1/auth/login", json={"username": username, "password": _FIXTURE_PW})
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


async def _user(client: AsyncClient, admin: dict, username: str) -> dict:
    grp = await client.post(
        "/api/v1/groups/", headers=admin, json={"name": f"ann_{username}", "permissions": ["printers:read"]}
    )
    assert grp.status_code == 201, grp.text
    created = await client.post(
        "/api/v1/users/",
        headers=admin,
        json={"username": username, "password": _FIXTURE_PW, "role": "user", "group_ids": [grp.json()["id"]]},
    )
    assert created.status_code == 201, created.text
    login = await client.post("/api/v1/auth/login", json={"username": username, "password": _FIXTURE_PW})
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest.mark.integration
class TestAuthOff:
    @pytest.mark.asyncio
    async def test_listed_with_every_language_and_unread(self, async_client: AsyncClient, db_session):
        await _seed(db_session, "a1")
        body = await _get(async_client)
        assert body["visible"] is True
        [item] = body["announcements"]
        assert item["id"] == "a1" and item["level"] == "important" and item["read"] is False
        assert set(item["texts"]) == {"en", "de"}

    @pytest.mark.asyncio
    async def test_read_sticks(self, async_client: AsyncClient, db_session):
        await _seed(db_session, "a1")
        assert (await async_client.post(f"{URL}/a1/read")).status_code == 204
        assert (await _items(async_client))[0]["read"] is True

    @pytest.mark.asyncio
    async def test_visible_with_nothing_published(self, async_client: AsyncClient):
        # The sidebar entry stays for whoever may see announcements, so an empty
        # inbox has to say "visible", not look like "not for you".
        assert await _get(async_client) == {"visible": True, "announcements": []}

    @pytest.mark.asyncio
    async def test_unknown_id_is_404(self, async_client: AsyncClient):
        assert (await async_client.post(f"{URL}/nope/read")).status_code == 404

    @pytest.mark.asyncio
    async def test_switched_off_shows_nothing(self, async_client: AsyncClient, db_session):
        await _seed(db_session, "a1")
        await _setting(db_session, "announcements_enabled", "false")
        assert await _get(async_client) == {"visible": False, "announcements": []}
        assert (await async_client.post(f"{URL}/a1/read")).status_code == 404


@pytest.mark.integration
class TestAuthOn:
    @pytest.mark.asyncio
    async def test_signed_out_is_401(self, async_client: AsyncClient, db_session):
        await _admin(async_client, "annadmin0")
        assert (await async_client.get(URL)).status_code == 401

    @pytest.mark.asyncio
    async def test_admin_sees_them_a_user_does_not(self, async_client: AsyncClient, db_session):
        await _seed(db_session, "a1")
        admin = await _admin(async_client, "annadmin1")
        user = await _user(async_client, admin, "annuser1")
        admin_view = await _get(async_client, admin)
        assert admin_view["visible"] is True
        assert [i["id"] for i in admin_view["announcements"]] == ["a1"]
        assert await _get(async_client, user) == {"visible": False, "announcements": []}
        assert (await async_client.post(f"{URL}/a1/read", headers=user)).status_code == 404

    @pytest.mark.asyncio
    async def test_all_users_setting_shows_them_with_separate_read_state(self, async_client: AsyncClient, db_session):
        await _seed(db_session, "a1")
        admin = await _admin(async_client, "annadmin2")
        user = await _user(async_client, admin, "annuser2")
        await _setting(db_session, "announcements_all_users", "true")

        assert (await async_client.post(f"{URL}/a1/read", headers=user)).status_code == 204
        user_view = await _get(async_client, user)
        assert user_view["visible"] is True
        assert user_view["announcements"][0]["read"] is True
        assert (await _items(async_client, admin))[0]["read"] is False

    @pytest.mark.asyncio
    async def test_admin_entry_visible_with_nothing_published(self, async_client: AsyncClient):
        admin = await _admin(async_client, "annadmin3")
        user = await _user(async_client, admin, "annuser3")
        assert await _get(async_client, admin) == {"visible": True, "announcements": []}
        assert (await _get(async_client, user))["visible"] is False


@pytest.mark.integration
class TestSettings:
    @pytest.mark.asyncio
    async def test_both_switches_round_trip(self, async_client: AsyncClient):
        defaults = (await async_client.get("/api/v1/settings/")).json()
        assert defaults["announcements_enabled"] is True
        assert defaults["announcements_all_users"] is False
        r = await async_client.put(
            "/api/v1/settings/", json={"announcements_enabled": False, "announcements_all_users": True}
        )
        assert r.status_code == 200, r.text
        after = (await async_client.get("/api/v1/settings/")).json()
        assert after["announcements_enabled"] is False
        assert after["announcements_all_users"] is True
