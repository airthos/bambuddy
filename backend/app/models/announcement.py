"""Announcements from the Bambuddy maintainers, and who has read them.

Fetched from a signed feed on GitHub (services/announcements.py). Only the ones
that target this install are stored, and the feed is authoritative: a message
withdrawn upstream is deleted here on the next fetch, together with its read
markers.

``AnnouncementRead.user_id`` is nullable: with authentication off there are no
users, and the install's read state is a single NULL-keyed row per message.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class Announcement(Base):
    __tablename__ = "announcements"

    id: Mapped[int] = mapped_column(primary_key=True)
    # The feed's id for the message. Stable across edits upstream, so a corrected
    # typo does not come back as unread.
    public_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    level: Mapped[str] = mapped_column(String(16))  # info | important | critical
    # JSON {"en": {"title", "body", "link_label"?}, ...}. Text for SQLite/Postgres
    # uniformity; the service serialises with json.dumps.
    texts: Mapped[str] = mapped_column(Text)
    link_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Naive UTC, like every other timestamp in Bambuddy.
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class AnnouncementRead(Base):
    __tablename__ = "announcement_reads"
    __table_args__ = (UniqueConstraint("announcement_id", "user_id", name="uq_announcement_reads_user"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    announcement_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("announcements.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    read_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
