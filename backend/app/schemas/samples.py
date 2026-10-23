from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from app.core.config import get_settings

_max = get_settings().max_coord

# Одно число кадра: конечное (без NaN/Infinity) и в разумных пределах
Coord = Annotated[float, Field(allow_inf_nan=False, ge=-_max, le=_max)]


class SampleCreate(BaseModel):
    gesture_id: int
    # Кадры по 126 чисел; длина кадров и их количество проверяются в сервисе,
    # чтобы вернуть понятное сообщение на таджикском/русском
    landmarks: list[list[Coord]]
    hand_count: int = Field(ge=1, le=2)


class SampleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    gesture_id: int
    user_id: int | None
    hand_count: int
    frame_count: int
    is_approved: bool
    created_at: datetime


class SampleDetail(SampleOut):
    landmarks: list[list[float]]


class SampleApprove(BaseModel):
    is_approved: bool = True
