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


class SpeechIn(BaseModel):
    """Одна попытка в тренажёре произношения: оценку (0…1) считает браузер."""

    word: str = Field(min_length=1, max_length=100)
    score: float = Field(ge=0, le=1)
    heard: str | None = Field(default=None, max_length=200)


class SpeechOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    word: str
    score: float
    ok: bool
    created_at: datetime


class SpeechWord(BaseModel):
    word: str
    attempts: int
    correct: int
    best: float
    last: float
    mastered: bool


class SpeechAttempt(BaseModel):
    word: str
    score: float
    ok: bool
    created_at: datetime


class Speech(BaseModel):
    attempts: int
    correct: int
    mastered_words: int
    words: list[SpeechWord]
    history: list[SpeechAttempt]


class ProfileOut(BaseModel):
    user: UserOut
    points: int
    level: str
    next_level_points: int | None
    contribution: Contribution
    knowledge: Knowledge
    speech: Speech


class LeaderRow(BaseModel):
    username: str
    value: int


class LeaderboardOut(BaseModel):
    contributors: list[LeaderRow]
    players: list[LeaderRow]
