from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.user import utcnow


class PracticeResult(Base):
    """Одна игра в тренажёре «Машқ»: сколько жестов человек показал правильно.

    rounds — по раунду: [{"label": "Салом", "ok": true}, ...]. Из них считается,
    какие жесты человек уже знает (профиль), — на сервер уходят только эти итоги, не видео.
    """

    __tablename__ = "practice_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    score: Mapped[int] = mapped_column(Integer)
    correct: Mapped[int] = mapped_column(Integer)
    total: Mapped[int] = mapped_column(Integer)
    rounds: Mapped[list[dict]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
