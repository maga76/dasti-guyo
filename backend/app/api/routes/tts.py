"""Таджикский голос: текст → WAV. Нужен, когда фразы нет среди заранее озвученных."""

from typing import Annotated

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse

from app.core.errors import AppError
from app.services import tts

router = APIRouter(tags=["tts"])


@router.get("/tts", response_class=FileResponse, summary="Озвучить текст по-таджикски (WAV)")
def speak(text: Annotated[str, Query(min_length=1, max_length=tts.MAX_TEXT)]):
    if not tts.normalize(text):
        raise AppError(422, "tts_text")
    try:
        path = tts.cached_wav(text)
    except tts.TtsUnavailable:
        raise AppError(503, "tts_unavailable") from None
    except ValueError:
        raise AppError(422, "tts_text") from None
    # Одинаковый текст всегда звучит одинаково — браузер может хранить файл долго
    return FileResponse(path, media_type="audio/wav", headers={"Cache-Control": "public, max-age=2592000"})
