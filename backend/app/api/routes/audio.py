"""Аудиозаписи слов и фраз (запасной вариант, если в браузере нет таджикского голоса)."""

from typing import Annotated

from fastapi import APIRouter, File, Form, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.api.deps import DB, Admin, Contributor, get_or_404
from app.api.serializers import audio_out
from app.core.errors import AppError
from app.models import AudioClip, Gesture, Phrase
from app.schemas.models import AudioOut
from app.services.audio_storage import delete_media_file, media_path, save_audio

router = APIRouter(prefix="/audio", tags=["audio"])


@router.post("", response_model=AudioOut, status_code=status.HTTP_201_CREATED)
async def upload_audio(
    request: Request,
    db: DB,
    user: Contributor,
    file: Annotated[UploadFile, File(description="webm/ogg/mp3/m4a/wav, до 2 МБ")],
    gesture_id: Annotated[int | None, Form()] = None,
    phrase_id: Annotated[int | None, Form()] = None,
):
    if (gesture_id is None) == (phrase_id is None):
        raise AppError(422, "audio_target")
    # База — в потоке, приём файла — асинхронно: долгие загрузки с телефона не задерживают других
    await run_in_threadpool(_check_target, db, gesture_id, phrase_id)
    path, content_type = await save_audio(file)
    return await run_in_threadpool(_add_clip, request, db, user.id, gesture_id, phrase_id, path, content_type)


def _check_target(db, gesture_id: int | None, phrase_id: int | None) -> None:
    if gesture_id is not None:
        get_or_404(db, Gesture, gesture_id, "gesture_not_found")
    else:
        get_or_404(db, Phrase, phrase_id, "phrase_not_found")


def _add_clip(request: Request, db, user_id: int, gesture_id, phrase_id, path: str, content_type: str):
    clip = AudioClip(
        gesture_id=gesture_id, phrase_id=phrase_id, file_path=path, content_type=content_type, user_id=user_id
    )
    db.add(clip)
    db.commit()
    db.refresh(clip)
    return audio_out(request, clip)


@router.get("", response_model=list[AudioOut])
def list_audio(request: Request, db: DB, gesture_id: int | None = None, phrase_id: int | None = None):
    query = select(AudioClip).order_by(AudioClip.id)
    if gesture_id is not None:
        query = query.where(AudioClip.gesture_id == gesture_id)
    if phrase_id is not None:
        query = query.where(AudioClip.phrase_id == phrase_id)
    return [audio_out(request, clip) for clip in db.scalars(query)]


@router.get("/{audio_id}", name="get_audio", response_class=FileResponse, summary="Аудиофайл")
def get_audio(audio_id: int, db: DB):
    clip = get_or_404(db, AudioClip, audio_id, "audio_not_found")
    path = media_path(clip.file_path)
    if not path.is_file():
        raise AppError(404, "audio_not_found")
    # Файлы не меняются — браузер может хранить их долго
    return FileResponse(path, media_type=clip.content_type, headers={"Cache-Control": "public, max-age=604800"})


@router.delete("/{audio_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_audio(audio_id: int, db: DB, _: Admin):
    clip = get_or_404(db, AudioClip, audio_id, "audio_not_found")
    delete_media_file(clip.file_path)
    db.delete(clip)
    db.commit()
