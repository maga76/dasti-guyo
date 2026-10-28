"""Сохранение аудиозаписей слов в media/audio с проверкой типа и размера."""

import asyncio
import uuid
from pathlib import Path

from fastapi import UploadFile

from app.core.config import get_settings
from app.core.errors import AppError

# MIME-тип → расширение файла
ALLOWED_TYPES = {
    "audio/webm": "webm",  # Chrome, Firefox (MediaRecorder)
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",  # Safari (MediaRecorder)
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
}


def _looks_like_audio(head: bytes) -> bool:
    """Проверка по первым байтам: заголовок от браузера можно подделать, содержимое — сложнее."""
    return (
        head.startswith(b"\x1a\x45\xdf\xa3")  # webm / matroska
        or head.startswith(b"OggS")
        or head.startswith(b"ID3")  # mp3 с тегами
        or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0)  # mp3 / aac (ADTS)
        or head[4:8] == b"ftyp"  # mp4 / m4a
        or (head.startswith(b"RIFF") and head[8:12] == b"WAVE")
    )


async def save_audio(file: UploadFile) -> tuple[str, str]:
    """Сохраняет файл. Возвращает (путь относительно media/, MIME-тип)."""
    settings = get_settings()
    # «audio/webm;codecs=opus» → «audio/webm»
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_TYPES:
        raise AppError(415, "audio_bad_type")

    data = await file.read(settings.max_audio_bytes + 1)
    if len(data) > settings.max_audio_bytes:
        raise AppError(413, "audio_too_large")
    if not data:
        raise AppError(400, "audio_empty")
    if not _looks_like_audio(data[:16]):
        raise AppError(415, "audio_bad_type")

    name = f"{uuid.uuid4().hex}.{ALLOWED_TYPES[content_type]}"
    # Запись на диск — в потоке: пока пишется файл, сервер обслуживает других
    await asyncio.to_thread(_write, settings.audio_dir / name, data)
    return f"audio/{name}", content_type


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def delete_media_file(relative_path: str) -> None:
    path = (get_settings().media_dir / relative_path).resolve()
    # Не выходим за пределы media/
    if get_settings().media_dir.resolve() in path.parents and path.is_file():
        path.unlink()


def media_path(relative_path: str) -> Path:
    return get_settings().media_dir / relative_path
