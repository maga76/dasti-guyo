"""Женский голос «Мадина» для таджикских слов.

Нейросетевой голос Microsoft uz-UZ-MadinaNeural (через бесплатный сервис чтения вслух
браузера Edge, библиотека edge-tts). Таджикского голоса у Microsoft нет, а узбекское
произношение очень близко к таджикскому, поэтому текст сначала переводится в узбекскую
латиницу (tajik_latin.py) — так «Қалам» звучит как Qalam, «Ҷавоб» — как Javob.

Каждая фраза озвучивается один раз и хранится в media/voice/ (mp3).
Для сайта — асинхронно (cached_mp3_async): пока сервис Microsoft отвечает, сервер обслуживает
других; одинаковые фразы, запрошенные одновременно, озвучиваются один раз.
edge-tts — необязательная зависимость; без неё (или без интернета на сервере) голос недоступен.
"""

import asyncio
import hashlib
import uuid
from pathlib import Path

from app.core.config import get_settings
from app.services.tajik_latin import to_latin
from app.services.tts import TtsUnavailable, normalize

VOICE = "uz-UZ-MadinaNeural"
RATE = "-10%"  # чуть медленнее — чётче для тренажёра произношения
VERSION = "m1"
# Русский текст (голосовые сообщения чат-бота) — русский женский голос, без перевода в латиницу
RU_VOICE = "ru-RU-SvetlanaNeural"
# Голосовые сообщения длиннее отдельных слов; адрес запроса при этом не выходит за 8 КБ
MAX_TEXT = 800


def cache_key(text: str, voice: str = "madina") -> str:
    prefix = VERSION if voice == "madina" else f"{VERSION}|{voice}"  # старые файлы «Мадины» остаются
    return hashlib.sha1(f"{prefix}|{normalize(text)}".encode()).hexdigest()[:16]


async def _synthesize(text: str, voice: str = "madina") -> bytes:
    try:
        import edge_tts
    except ImportError as err:
        raise TtsUnavailable("edge-tts не установлен") from err
    if voice == "ru":
        speech = edge_tts.Communicate(text, RU_VOICE)
    else:
        speech = edge_tts.Communicate(to_latin(text), VOICE, rate=RATE)
    data = bytearray()
    async for chunk in speech.stream():
        if chunk["type"] == "audio":
            data.extend(chunk["data"])
    if not data:
        raise TtsUnavailable("голос не ответил")
    return bytes(data)


def synthesize(text: str) -> bytes:
    """Текст (таджикская кириллица) → mp3. Для скриптов (tools/pregenerate_voice.py), без event loop."""
    try:
        return asyncio.run(_synthesize(text))
    except TtsUnavailable:
        raise
    except Exception as err:  # сеть, ответ сервиса
        raise TtsUnavailable(str(err)) from err


def _path(text: str, voice: str = "madina") -> Path:
    folder = get_settings().media_dir / "voice"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{cache_key(text, voice)}.mp3"


def _save(path: Path, data: bytes) -> None:
    # Сначала во временный файл: другой запрос не должен получить недописанный mp3
    tmp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


_locks: dict[str, asyncio.Lock] = {}


async def cached_mp3_async(text: str, voice: str = "madina") -> Path:
    """Для сайта: ждём сервис Microsoft, не занимая поток сервера. voice: madina | ru."""
    path = _path(text, voice)
    if path.exists():
        return path
    key = path.stem
    lock = _locks.setdefault(key, asyncio.Lock())
    try:
        async with lock:
            if not path.exists():  # пока ждали, другой запрос мог уже озвучить
                try:
                    data = await _synthesize(text, voice)
                except TtsUnavailable:
                    raise
                except Exception as err:  # сеть, ответ сервиса
                    raise TtsUnavailable(str(err)) from err
                await asyncio.to_thread(_save, path, data)
    finally:
        if not lock.locked():
            _locks.pop(key, None)
    return path
