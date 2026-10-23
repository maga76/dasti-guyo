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
