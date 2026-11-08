"""Женские голоса для таджикских слов: «Мягкий» (Gemini) и «Мадина» (Microsoft).

«Мягкий» — голос Achernar модели Gemini TTS: понимает таджикский сам, звучит естественнее, но
бесплатный лимит у него маленький и новая фраза готовится несколько секунд. Поэтому каждая
фраза озвучивается один раз, а когда лимит кончился — сайт временно говорит «Мадиной».

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
import base64
import hashlib
import io
import time
import uuid
import wave
from pathlib import Path

import httpx

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

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent"
GEMINI_VOICE = "Achernar"
GEMINI_MAX_TEXT = 200  # лимит маленький: длинные тексты читает «Мадина»
GEMINI_TIMEOUT = 7.0  # дольше на сайте не ждём — лучше сразу сказать «Мадиной»
GEMINI_REST = 30 * 60  # после ответа «лимит исчерпан» столько времени Gemini не спрашиваем
MP3_KBPS = 64
_gemini_rest_until = 0.0


def gemini_resting() -> bool:
    """Лимит Gemini исчерпан, и время отдыха ещё не вышло."""
    return time.monotonic() < _gemini_rest_until


def reset_gemini_rest() -> None:
    """Снова разрешить запросы к Gemini (скрипт записи сам ждёт, сколько нужно)."""
    global _gemini_rest_until
    _gemini_rest_until = 0.0


def _wav_to_mp3(data: bytes) -> bytes:
    """WAV в MP3: файл становится в 6 раз меньше — на медленном интернете это важно."""
    import lameenc

    with wave.open(io.BytesIO(data)) as source:
        rate, pcm = source.getframerate(), source.readframes(source.getnframes())
    encoder = lameenc.Encoder()
    encoder.set_bit_rate(MP3_KBPS)
    encoder.set_in_sample_rate(rate)
    encoder.set_channels(1)
    encoder.set_quality(2)
    return bytes(encoder.encode(pcm) + encoder.flush())


async def _gemini(text: str) -> bytes:
    global _gemini_rest_until
    key = get_settings().gemini_api_key
    if not key or len(text) > GEMINI_MAX_TEXT or gemini_resting():
        raise TtsUnavailable("Gemini сейчас не озвучивает")
    body = {
        "contents": [{"parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": GEMINI_VOICE}}},
        },
    }
    async with httpx.AsyncClient() as client:
        res = await client.post(GEMINI_URL, json=body, headers={"x-goog-api-key": key}, timeout=GEMINI_TIMEOUT)
    if res.status_code == 429:
        _gemini_rest_until = time.monotonic() + GEMINI_REST
    if res.status_code != 200:
        raise TtsUnavailable(f"Gemini ответил {res.status_code}")
    try:
        audio = res.json()["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
        return _wav_to_mp3(base64.b64decode(audio))
    except (KeyError, IndexError, ValueError, wave.Error) as err:
        raise TtsUnavailable("Gemini не прислал звук") from err


def cache_key(text: str, voice: str = "madina") -> str:
    prefix = VERSION if voice == "madina" else f"{VERSION}|{voice}"  # старые файлы «Мадины» остаются
    return hashlib.sha1(f"{prefix}|{normalize(text)}".encode()).hexdigest()[:16]


async def _synthesize(text: str, voice: str = "madina") -> bytes:
    if voice == "achernar":
        return await _gemini(text)
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


def synthesize(text: str, voice: str = "madina") -> bytes:
    """Текст (таджикская кириллица) → mp3. Для скриптов (tools/pregenerate_voice.py), без event loop."""
    try:
        return asyncio.run(_synthesize(text, voice))
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
    """Для сайта: ждём сервис голоса, не занимая поток сервера. voice: achernar | madina | ru."""
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
