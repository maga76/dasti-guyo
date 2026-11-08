"""Таджикский голос: текст → звук. Нужен, когда фразы нет среди заранее озвученных
(например, слова, которые человек сам добавил во вкладке «Омӯзиш»)."""

from typing import Annotated, Literal

from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from app.core.errors import AppError
from app.services import tts, voice

router = APIRouter(tags=["tts"])

CACHE = {"Cache-Control": "public, max-age=2592000"}
NO_STORE = {"Cache-Control": "no-store"}  # замена голоса: когда лимит вернётся, браузер спросит снова


@router.get("/tts", response_class=FileResponse, summary="Озвучить текст по-таджикски")
async def speak(
    text: Annotated[str, Query(min_length=1, max_length=voice.MAX_TEXT)],
    voice_id: Annotated[Literal["mms", "madina", "ru", "achernar"], Query(alias="voice")] = "mms",
):
    """voice=achernar — мягкий женский голос Gemini (mp3), если лимит кончился — «Мадина».
    voice=madina — женский голос «Мадина» (mp3), если не вышло — нейросеть MMS (wav).
    voice=ru — русский женский голос (голосовые сообщения чат-бота на русском), запасного нет.
    Асинхронно: «Мадину» ждём у сервиса Microsoft, не занимая сервер; MMS считает долго —
    в отдельном потоке, чтобы остальные запросы не стояли."""
    if not tts.normalize(text):
        raise AppError(422, "tts_text")
    headers = CACHE
    if voice_id == "achernar":
        try:
            return FileResponse(await voice.cached_mp3_async(text, "achernar"), media_type="audio/mpeg", headers=CACHE)
        except tts.TtsUnavailable:
            voice_id, headers = "madina", NO_STORE
    if voice_id == "ru":
        try:
            return FileResponse(await voice.cached_mp3_async(text, "ru"), media_type="audio/mpeg", headers=CACHE)
        except tts.TtsUnavailable:
            raise AppError(503, "tts_unavailable") from None
    if voice_id == "madina":
        try:
            # Одинаковый текст всегда звучит одинаково — браузер может хранить файл долго
            return FileResponse(await voice.cached_mp3_async(text), media_type="audio/mpeg", headers=headers)
        except tts.TtsUnavailable:
            pass  # попробуем MMS
    if len(text) > tts.MAX_TEXT:  # MMS считает долго — длинные тексты только «Мадиной»
        raise AppError(422, "tts_text")
    try:
        path = await run_in_threadpool(tts.cached_wav, text)
    except tts.TtsUnavailable:
        raise AppError(503, "tts_unavailable") from None
    except ValueError:
        raise AppError(422, "tts_text") from None
    return FileResponse(path, media_type="audio/wav", headers=headers)
