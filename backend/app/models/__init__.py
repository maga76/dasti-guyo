"""Модели БД. Импорт всех моделей здесь нужен Alembic'у для автогенерации миграций."""

from app.models.audio import AudioClip
from app.models.gesture import Gesture, Sample
from app.models.model_version import ModelVersion
from app.models.phrase import Phrase, QuickPhrase
from app.models.user import Role, User

__all__ = ["AudioClip", "Gesture", "ModelVersion", "Phrase", "QuickPhrase", "Role", "Sample", "User"]
