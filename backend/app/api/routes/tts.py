"""Таджикский голос: текст → звук. Нужен, когда фразы нет среди заранее озвученных
(например, слова, которые человек сам добавил во вкладке «Омӯзиш»)."""

from typing import Annotated, Literal

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse

from app.core.errors import AppError
from app.services import tts, voice

router = APIRouter(tags=["tts"])

CACHE = {"Cache-Control": "public, max-age=2592000"}


@router.get("/tts", response_class=FileResponse, summary="Озвучить текст по-таджикски")
def speak(
    text: Annotated[str, Query(min_length=1, max_length=tts.MAX_TEXT)],
    voice_id: Annotated[Literal["mms", "madina"], Query(alias="voice")] = "mms",
):
    """voice=madina — женский голос «Мадина» (mp3), если не вышло — нейросеть MMS (wav)."""
    if not tts.normalize(text):
        raise AppError(422, "tts_text")
    if voice_id == "madina":
        try:
            # Одинаковый текст всегда звучит одинаково — браузер может хранить файл долго
            return FileResponse(voice.cached_mp3(text), media_type="audio/mpeg", headers=CACHE)
        except tts.TtsUnavailable:
            pass  # попробуем MMS
    try:
        path = tts.cached_wav(text)
    except tts.TtsUnavailable:
        raise AppError(503, "tts_unavailable") from None
    except ValueError:
        raise AppError(422, "tts_text") from None
    return FileResponse(path, media_type="audio/wav", headers=CACHE)
