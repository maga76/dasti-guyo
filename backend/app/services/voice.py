"""Женский голос «Мадина» для таджикских слов.

Нейросетевой голос Microsoft uz-UZ-MadinaNeural (через бесплатный сервис чтения вслух
браузера Edge, библиотека edge-tts). Таджикского голоса у Microsoft нет, а узбекское
произношение очень близко к таджикскому, поэтому текст сначала переводится в узбекскую
латиницу (tajik_latin.py) — так «Қалам» звучит как Qalam, «Ҷавоб» — как Javob.

Каждая фраза озвучивается один раз и хранится в media/voice/ (mp3).
edge-tts — необязательная зависимость; без неё (или без интернета на сервере) голос недоступен.
"""

import asyncio
import hashlib

from app.core.config import get_settings
from app.services.tajik_latin import to_latin
from app.services.tts import TtsUnavailable, normalize

VOICE = "uz-UZ-MadinaNeural"
RATE = "-10%"  # чуть медленнее — чётче для тренажёра произношения
VERSION = "m1"


def cache_key(text: str) -> str:
    return hashlib.sha1(f"{VERSION}|{normalize(text)}".encode()).hexdigest()[:16]


async def _synthesize(text: str) -> bytes:
    try:
        import edge_tts
    except ImportError as err:
        raise TtsUnavailable("edge-tts не установлен") from err
    data = bytearray()
    async for chunk in edge_tts.Communicate(to_latin(text), VOICE, rate=RATE).stream():
        if chunk["type"] == "audio":
            data.extend(chunk["data"])
    if not data:
        raise TtsUnavailable("голос не ответил")
    return bytes(data)


def synthesize(text: str) -> bytes:
    """Текст (таджикская кириллица) → mp3."""
    try:
        return asyncio.run(_synthesize(text))
    except TtsUnavailable:
        raise
    except Exception as err:  # сеть, ответ сервиса
        raise TtsUnavailable(str(err)) from err


def cached_mp3(text: str):
    folder = get_settings().media_dir / "voice"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{cache_key(text)}.mp3"
    if not path.exists():
        path.write_bytes(synthesize(text))
    return path
