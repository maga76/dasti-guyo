from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class Role(StrEnum):
    admin = "admin"  # словарь, фразы, пользователи, обучение, публикация модели
    contributor = "contributor"  # записывает примеры жестов и аудио


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    # Вход через Google: постоянный номер аккаунта Google («sub») и почта (не показывается другим)
    google_id: Mapped[str | None] = mapped_column(String(64), unique=True, index=True, default=None)
    email: Mapped[str | None] = mapped_column(String(255), default=None)
    role: Mapped[str] = mapped_column(String(20), default=Role.contributor)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
