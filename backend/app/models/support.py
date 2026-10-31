from datetime import datetime
from enum import StrEnum

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.user import utcnow


class SupportKind(StrEnum):
    problem = "problem"  # что-то не работает
    idea = "idea"  # что добавить
    other = "other"


class SupportStatus(StrEnum):
    new = "new"
    done = "done"  # администратор прочитал и разобрал


class SupportMessage(Base):
    """Сообщение в поддержку: проблема или идея. Писать может любой, без входа;
    если человек вошёл — сообщение привязано к его аккаунту."""

    __tablename__ = "support_messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    kind: Mapped[str] = mapped_column(String(20), default=SupportKind.problem)
    message: Mapped[str] = mapped_column(Text)
    contact: Mapped[str | None] = mapped_column(String(120))  # телефон, Telegram, почта — по желанию
    page: Mapped[str | None] = mapped_column(String(40))  # с какой вкладки написали
    user_agent: Mapped[str | None] = mapped_column(String(300))  # браузер и устройство — помогает найти проблему
    status: Mapped[str] = mapped_column(String(20), default=SupportStatus.new, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
