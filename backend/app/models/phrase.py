from sqlalchemy import JSON, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Phrase(Base):
    """Правило сборки предложения: последовательность слов → готовый текст.
    Например ["ман", "об", "хостан"] → «Ман об мехоҳам»."""

    __tablename__ = "phrases"

    id: Mapped[int] = mapped_column(primary_key=True)
    words: Mapped[list[str]] = mapped_column(JSON)
    text_tj: Mapped[str] = mapped_column(String(500))
    text_ru: Mapped[str] = mapped_column(String(500), default="")


class QuickPhrase(Base):
    """Быстрая фраза — крупная кнопка на экране перевода."""

    __tablename__ = "quick_phrases"

    id: Mapped[int] = mapped_column(primary_key=True)
    text_tj: Mapped[str] = mapped_column(String(500))
    text_ru: Mapped[str] = mapped_column(String(500), default="")
    order: Mapped[int] = mapped_column(Integer, default=0)
