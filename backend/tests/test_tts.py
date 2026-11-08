"""Озвучка: логика пауз, обработка звука и эндпоинт. Сама нейросеть в тестах не загружается."""

import io
import wave

import numpy as np

from app.services import tts

API = "/api/v1"


def test_normalize_and_key_ignore_case_and_spaces():
    assert tts.normalize("  Ба ман   БАД аст ") == "ба ман бад аст"
    assert tts.cache_key("Салом") == tts.cache_key(" салом ")
    assert tts.cache_key("Салом") != tts.cache_key("Хайр")


def test_split_adds_pauses_by_punctuation():
    chunks = tts._split("Салом, ман Алӣ. Шумо чӣ хел?")
    assert [c[0] for c in chunks] == ["салом", "ман алӣ", "шумо чӣ хел"]
    assert chunks[0][1] == tts.PAUSES[","]
    assert chunks[1][1] == tts.PAUSES["."]


def test_polish_trims_normalizes_and_fades():
    rate = tts.SAMPLE_RATE
    voice = 0.3 * np.sin(np.linspace(0, 200 * np.pi, rate // 2)).astype(np.float32)
    audio = np.concatenate([np.zeros(rate), voice, np.zeros(rate)])
    out = tts._polish(audio)
    assert len(out) < len(audio) * 0.6  # тишина по краям обрезана
    assert abs(np.abs(out).max() - 0.89) < 0.01  # громкость выровнена
    assert out[0] == 0 and out[-1] == 0  # мягкие края


def test_endpoint_generates_once_and_caches(client, monkeypatch):
    calls = []

    def fake_synthesize(text):
        calls.append(text)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(tts.SAMPLE_RATE)
            w.writeframes(b"\x00\x00" * 160)
        return buf.getvalue()

    monkeypatch.setattr(tts, "synthesize", fake_synthesize)
    for _ in range(2):
        res = client.get(f"{API}/tts", params={"text": "Ташаккур"})
        assert res.status_code == 200
        assert res.headers["content-type"] == "audio/wav"
        assert res.content.startswith(b"RIFF")
    assert calls == ["Ташаккур"]  # второй раз — из кэша


def test_endpoint_without_tts_packages(client, monkeypatch):
    def unavailable(text):
        raise tts.TtsUnavailable()

    monkeypatch.setattr(tts, "synthesize", unavailable)
    res = client.get(f"{API}/tts", params={"text": "Нест дар кэш"})
    assert res.status_code == 503
    assert res.json()["code"] == "tts_unavailable"


def test_endpoint_rejects_empty_text(client):
    assert client.get(f"{API}/tts", params={"text": "   "}).status_code == 422


def test_tajik_to_uzbek_latin():
    from app.services.tajik_latin import to_latin

    assert to_latin("Салом") == "Salom"
    assert to_latin("Қалам") == "Qalam"
    assert to_latin("Ғалаба") == "Gʻalaba"
    assert to_latin("Ҷавоб") == "Javob"
    assert to_latin("Дӯст") == "Doʻst"
    assert to_latin("Ман об мехоҳам") == "Man ob mexoham"
    assert to_latin("Ерӣ, ёрӣ!") == "Yeri, yori!"


def test_madina_voice_endpoint(client, monkeypatch):
    from app.services import voice

    calls = []

    async def fake_mp3(text, voice="madina"):
        calls.append(text)
        return b"ID3fake-mp3"

    monkeypatch.setattr(voice, "_synthesize", fake_mp3)
    for _ in range(2):
        res = client.get(f"{API}/tts", params={"text": "Раҳмат", "voice": "madina"})
        assert res.status_code == 200
        assert res.headers["content-type"] == "audio/mpeg"
        assert res.content == b"ID3fake-mp3"
    assert calls == ["Раҳмат"]  # второй раз — из кэша


def test_madina_falls_back_to_mms(client, monkeypatch):
    from app.services import voice

    async def offline(text, voice="madina"):
        raise tts.TtsUnavailable()

    monkeypatch.setattr(voice, "_synthesize", offline)
    monkeypatch.setattr(tts, "synthesize", lambda text: b"RIFF-wav")
    res = client.get(f"{API}/tts", params={"text": "Хуб шуд", "voice": "madina"})
    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/wav"


def test_madina_same_text_at_once_is_voiced_once(tmp_path, monkeypatch):
    """Два одновременных запроса одной фразы — сервис Microsoft вызывается один раз."""
    import asyncio

    from app.services import voice

    monkeypatch.setattr(voice, "_path", lambda text, voice="madina": tmp_path / "same.mp3")
    calls = []

    async def slow_mp3(text, voice="madina"):
        calls.append(text)
        await asyncio.sleep(0.05)
        return b"ID3slow"

    monkeypatch.setattr(voice, "_synthesize", slow_mp3)

    async def both():
        return await asyncio.gather(voice.cached_mp3_async("Салом"), voice.cached_mp3_async("Салом"))

    first, second = asyncio.run(both())
    assert first == second and first.read_bytes() == b"ID3slow"
    assert calls == ["Салом"]


def test_soft_voice_endpoint_caches(client, monkeypatch):
    from app.services import voice

    calls = []

    async def fake_mp3(text, voice="madina"):
        calls.append(voice)
        return b"ID3soft"

    monkeypatch.setattr(voice, "_synthesize", fake_mp3)
    for _ in range(2):
        res = client.get(f"{API}/tts", params={"text": "Нарм гап", "voice": "achernar"})
        assert res.status_code == 200 and res.content == b"ID3soft"
        assert "max-age" in res.headers["cache-control"]
    assert calls == ["achernar"]


def test_soft_voice_limit_falls_back_to_madina_uncached(client, monkeypatch):
    """Лимит кончился — звучит «Мадина», но браузер не запоминает её вместо нового голоса."""
    from app.services import voice

    async def limited(text, voice="madina"):
        if voice == "achernar":
            raise tts.TtsUnavailable()
        return b"ID3madina"

    monkeypatch.setattr(voice, "_synthesize", limited)
    res = client.get(f"{API}/tts", params={"text": "Лимит тамом", "voice": "achernar"})
    assert res.status_code == 200 and res.content == b"ID3madina"
    assert res.headers["cache-control"] == "no-store"


def test_gemini_rests_after_limit(monkeypatch):
    """Ответ 429 — следующие фразы не ждут Gemini, а сразу идут запасному голосу."""
    import asyncio
    from types import SimpleNamespace

    import httpx

    from app.services import voice

    calls = []

    async def fake_post(self, url, **kwargs):
        calls.append(url)
        return httpx.Response(429)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(voice, "get_settings", lambda: SimpleNamespace(gemini_api_key="k"))
    monkeypatch.setattr(voice, "_gemini_rest_until", 0.0)
    for _ in range(2):
        try:
            asyncio.run(voice._gemini("Салом"))
        except tts.TtsUnavailable:
            pass
    assert len(calls) == 1
    assert voice.gemini_resting()


def test_wav_to_mp3():
    from app.services import voice

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x10\x00\xf0\xff" * 24000)
    mp3 = voice._wav_to_mp3(buf.getvalue())
    assert len(mp3) > 1000 and len(mp3) < len(buf.getvalue()) / 4


def test_unknown_voice_rejected(client):
    assert client.get(f"{API}/tts", params={"text": "Салом", "voice": "robot"}).status_code == 422


def test_russian_voice_and_long_text(client, monkeypatch):
    """voice=ru — русский голос (голосовые сообщения чат-бота); длинный текст MMS не берёт."""
    from app.services import voice

    calls = []

    async def fake_mp3(text, voice="madina"):
        calls.append(voice)
        return b"ID3ru"

    monkeypatch.setattr(voice, "_synthesize", fake_mp3)
    res = client.get(f"{API}/tts", params={"text": "Привет, как дела?", "voice": "ru"})
    assert res.status_code == 200 and res.content == b"ID3ru" and calls == ["ru"]
    # Тот же текст «Мадиной» — отдельный файл, не русский из кэша
    assert client.get(f"{API}/tts", params={"text": "Привет, как дела?", "voice": "madina"}).status_code == 200
    assert calls == ["ru", "madina"]
    assert client.get(f"{API}/tts", params={"text": "салом " * 80, "voice": "mms"}).status_code == 422
