"""Преобразование объектов БД в ответы API.

Адреса файлов — относительные (/api/v1/audio/1, /media/models/...): так они работают
и напрямую, и через прокси фронтенда, и по HTTPS с телефона.
"""

from fastapi import Request

from app.models import AudioClip, ModelVersion
from app.schemas.models import AudioOut, ModelVersionOut


def audio_out(request: Request, clip: AudioClip) -> AudioOut:
    return AudioOut(
        id=clip.id,
        gesture_id=clip.gesture_id,
        phrase_id=clip.phrase_id,
        content_type=clip.content_type,
        user_id=clip.user_id,
        created_at=clip.created_at,
        url=request.url_for("get_audio", audio_id=clip.id).path,
    )


def model_out(request: Request, model: ModelVersion) -> ModelVersionOut:
    # file_path = "models/v3/model.json", статика смонтирована на /media/models
    relative = model.file_path.removeprefix("models/")
    return ModelVersionOut(
        id=model.id,
        version=model.version,
        accuracy=model.accuracy,
        gesture_list=model.gesture_list,
        is_published=model.is_published,
        created_at=model.created_at,
        model_url=request.url_for("models", path=relative).path,
    )
