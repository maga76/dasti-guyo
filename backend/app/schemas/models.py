"""Схемы для модели распознавания, аудио, офлайн-словаря и статистики."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.schemas.dictionary import GestureOut, PhraseOut, QuickPhraseOut


class AudioOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    gesture_id: int | None
    phrase_id: int | None
    content_type: str
    user_id: int | None
    created_at: datetime
    url: str


class ModelVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    version: int
    accuracy: float
    gesture_list: list[dict]
    is_published: bool
    created_at: datetime
    # Адрес model.json для tf.loadLayersModel()
    model_url: str


class TrainRequest(BaseModel):
    # Сразу опубликовать, если новая модель не хуже текущей
    auto_publish: bool = False


class TrainStatus(BaseModel):
    state: Literal["idle", "running", "done", "failed"]
    message: str = ""
    progress: float = 0.0  # 0..1
    started_at: datetime | None = None
    finished_at: datetime | None = None
    model_version_id: int | None = None
    accuracy: float | None = None
    published: bool = False


class DictionaryOut(BaseModel):
    """Всё, что нужно фронтенду для работы офлайн, одним запросом."""

    gestures: list[GestureOut]
    phrases: list[PhraseOut]
    quick_phrases: list[QuickPhraseOut]
    audio: list[AudioOut]
    model: ModelVersionOut | None


class GestureStat(BaseModel):
    id: int
    name_tj: str
    category: str
    approved: int
    pending: int


class StatsOut(BaseModel):
    users: dict[str, int]
    gestures: int
    samples_total: int
    samples_approved: int
    samples_pending: int
    audio_clips: int
    model_versions: int
    published_version: int | None
    published_accuracy: float | None
    per_gesture: list[GestureStat]
