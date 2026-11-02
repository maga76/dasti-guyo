"""Чат-бот «Ёрдамчӣ»: вопрос → ответ ИИ (Google Gemini). Писать может любой посетитель."""

from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.core.limits import RateLimiter
from app.services import chatbot

router = APIRouter(prefix="/chat", tags=["chat"])

# Бесплатный лимит Gemini небольшой: не больше 20 вопросов за 10 минут с одного адреса
chat_limiter = RateLimiter(20, 600)


class ChatMessage(BaseModel):
    role: Literal["user", "bot"]
    text: str = Field(min_length=1, max_length=2000)


class ChatIn(BaseModel):
    # Последние сообщения переписки — чтобы бот помнил, о чём разговор
    messages: list[ChatMessage] = Field(min_length=1, max_length=20)


class ChatOut(BaseModel):
    reply: str


@router.get("/status", summary="Включён ли ИИ-помощник")
def status():
    return {"enabled": chatbot.enabled()}


@router.post("", response_model=ChatOut, summary="Задать вопрос ИИ-помощнику")
async def ask(request: Request, data: ChatIn):
    chat_limiter.hit(request.client.host if request.client else "unknown")
    return ChatOut(reply=await chatbot.reply([(m.role, m.text.strip()) for m in data.messages]))
