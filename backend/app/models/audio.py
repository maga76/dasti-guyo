from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.user import utcnow


class AudioClip(Base):
    """Запись слова или фразы голосом. Сам файл лежит в media/audio, в БД только путь."""

    __tablename__ = "audio_clips"
    __table_args__ = (
        # Ровно одно из двух: жест или фраза
        CheckConstraint(
            "(gesture_id IS NULL) <> (phrase_id IS NULL)", name="ck_audio_one_target"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    gesture_id: Mapped[int | None] = mapped_column(
        ForeignKey("gestures.id", ondelete="CASCADE"), index=True
    )
    phrase_id: Mapped[int | None] = mapped_column(ForeignKey("phrases.id", ondelete="CASCADE"), index=True)
    file_path: Mapped[str] = mapped_column(String(300))
    content_type: Mapped[str] = mapped_column(String(50))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
