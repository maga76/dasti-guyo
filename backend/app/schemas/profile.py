from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.users import UserOut


class PracticeRound(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    ok: bool


class PracticeIn(BaseModel):
    """Итог одной игры в тренажёре (10 раундов)."""

    score: int = Field(ge=0, le=10_000)
    rounds: list[PracticeRound] = Field(min_length=1, max_length=50)


class PracticeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    score: int
    correct: int
    total: int
    created_at: datetime


class GestureContribution(BaseModel):
    """Записи человека по одному жесту."""

    gesture_id: int
    name_tj: str
    name_ru: str
    approved: int
    pending: int


class Contribution(BaseModel):
    total: int
    approved: int
    pending: int
    # Сколько одобренных записей уже было, когда обучали опубликованную модель, — они в ней
    in_model: int
    model_version: int | None
    gestures: list[GestureContribution]


class WordSkill(BaseModel):
    """Насколько человек знает жест: последние попытки в тренажёре."""

    label: str
    attempts: int
    correct: int
    # 0…1 — доля правильных среди последних попыток (свежие важнее старых)
    mastery: float


class Knowledge(BaseModel):
    games: int
    best_score: int
    rounds: int
    correct: int
    # Знает жест, если mastery ≥ 0.6 хотя бы по 2 попыткам
    known_words: int
    words: list[WordSkill]
    history: list[PracticeOut]


class ProfileOut(BaseModel):
    user: UserOut
    points: int
    level: str
    next_level_points: int | None
    contribution: Contribution
    knowledge: Knowledge


class LeaderRow(BaseModel):
    username: str
    value: int


class LeaderboardOut(BaseModel):
    contributors: list[LeaderRow]
    players: list[LeaderRow]
