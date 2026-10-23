from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.user import utcnow


class Gesture(Base):
    """Слово/жест словаря. Категория «letter» — буквы дактильной азбуки,
    «system» — служебный класс «нет жеста»."""

    __tablename__ = "gestures"

    id: Mapped[int] = mapped_column(primary_key=True)
    name_tj: Mapped[str] = mapped_column(String(100), unique=True)
    name_ru: Mapped[str] = mapped_column(String(100), default="")
    category: Mapped[str] = mapped_column(String(50), default="word", index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    samples: Mapped[list["Sample"]] = relationship(
        back_populates="gesture", cascade="all, delete-orphan", passive_deletes=True
    )


class Sample(Base):
    """Одна запись жеста: последовательность кадров по 126 чисел."""

    __tablename__ = "samples"

    id: Mapped[int] = mapped_column(primary_key=True)
    gesture_id: Mapped[int] = mapped_column(ForeignKey("gestures.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    landmarks: Mapped[list] = mapped_column(JSON)
    # Хранится отдельно, чтобы список примеров не загружал тяжёлый JSON с точками
    frame_count: Mapped[int] = mapped_column(Integer)
    hand_count: Mapped[int] = mapped_column(Integer)
    is_approved: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    gesture: Mapped[Gesture] = relationship(back_populates="samples")
