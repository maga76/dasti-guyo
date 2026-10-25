from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.user import utcnow


class SpeechResult(Base):
    """Одна попытка в тренажёре произношения «Талаффуз»: какое слово человек повторял
    и насколько похоже получилось (0…1). heard — что услышал распознаватель речи.
    Звук на сервер не отправляется — только текст и оценка."""

    __tablename__ = "speech_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    word: Mapped[str] = mapped_column(String(100))
    score: Mapped[float] = mapped_column(Float)
    heard: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
