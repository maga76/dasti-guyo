"""Схемы словаря: жесты, правила фраз, быстрые фразы."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class GestureBase(BaseModel):
    name_tj: str = Field(min_length=1, max_length=100)
    name_ru: str = Field(default="", max_length=100)
    category: str = Field(default="word", max_length=50)
    description: str = Field(default="", max_length=2000)
    is_active: bool = True


class GestureCreate(GestureBase):
    pass


class GestureUpdate(BaseModel):
    name_tj: str | None = Field(default=None, min_length=1, max_length=100)
    name_ru: str | None = Field(default=None, max_length=100)
    category: str | None = Field(default=None, max_length=50)
    description: str | None = Field(default=None, max_length=2000)
    is_active: bool | None = None


class GestureOut(GestureBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime


class PhraseBase(BaseModel):
    words: list[str] = Field(min_length=1, max_length=20)
    text_tj: str = Field(min_length=1, max_length=500)
    text_ru: str = Field(default="", max_length=500)


class PhraseCreate(PhraseBase):
    pass


class PhraseUpdate(BaseModel):
    words: list[str] | None = Field(default=None, min_length=1, max_length=20)
    text_tj: str | None = Field(default=None, min_length=1, max_length=500)
    text_ru: str | None = Field(default=None, max_length=500)


class PhraseOut(PhraseBase):
    model_config = ConfigDict(from_attributes=True)

    id: int


class QuickPhraseBase(BaseModel):
    text_tj: str = Field(min_length=1, max_length=500)
    text_ru: str = Field(default="", max_length=500)
    order: int = 0


class QuickPhraseCreate(QuickPhraseBase):
    pass


class QuickPhraseUpdate(BaseModel):
    text_tj: str | None = Field(default=None, min_length=1, max_length=500)
    text_ru: str | None = Field(default=None, max_length=500)
    order: int | None = None


class QuickPhraseOut(QuickPhraseBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
