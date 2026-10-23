"""Таджикский голос: нейросеть Meta MMS-TTS (facebook/mms-tts-tgk, лицензия CC BY-NC 4.0).

Модель понимает таджикскую кириллицу целиком (ғ ӣ қ ӯ ҳ ҷ). Чтобы голос звучал
приятнее «сырого» вывода нейросети:
  - фраза делится по знакам препинания, между частями — естественные паузы;
  - темп чуть медленнее, интонация спокойнее (меньше «дрожания»);
  - тишина по краям обрезается, громкость выравнивается, начало и конец — мягкие;
  - одна и та же фраза всегда звучит одинаково (фиксированное зерно случайности).

Готовые записи кэшируются в media/tts/, поэтому каждая фраза генерируется один раз.
PyTorch и transformers — необязательные зависимости (requirements-tts.txt).
"""

import hashlib
import io
import re
import threading
import wave
from pathlib import Path

import numpy as np

from app.core.config import get_settings

MODEL_ID = "facebook/mms-tts-tgk"
# Если файлы модели скачаны заранее (см. README) — берём их отсюда, без обращения к интернету
LOCAL_MODEL_DIR = Path(__file__).resolve().parents[2] / "data" / "tts" / "mms-tts-tgk"
SAMPLE_RATE = 16000
# Меняется при изменении настроек звучания — старый кэш тогда не используется
VOICE_VERSION = "v1"

SPEAKING_RATE = 0.9  # < 1 — медленнее и разборчивее
NOISE_SCALE = 0.5  # меньше — ровнее интонация (по умолчанию 0.667)
NOISE_SCALE_DURATION = 0.6

# Паузы между частями фразы, секунды
PAUSES = {",": 0.18, ";": 0.25, ":": 0.25, "—": 0.2, ".": 0.4, "!": 0.4, "?": 0.4, "…": 0.45}
MAX_TEXT = 300

_lock = threading.Lock()
_model = None
_tokenizer = None


class TtsUnavailable(Exception):
    """PyTorch/transformers не установлены или модель не загрузилась."""


def normalize(text: str) -> str:
    """Единый вид текста: по нему же строится имя файла (и на сайте тоже)."""
    return re.sub(r"\s+", " ", text.strip().lower())


def cache_key(text: str) -> str:
    return hashlib.sha1(f"{VOICE_VERSION}|{normalize(text)}".encode()).hexdigest()[:16]


def _load():
    global _model, _tokenizer
    if _model is not None:
        return
    try:
        import torch  # noqa: F401
        from transformers import AutoTokenizer, VitsModel
    except ImportError as exc:
        raise TtsUnavailable("pip install -r requirements-tts.txt") from exc
    except OSError as exc:
        # Windows: не загрузились DLL PyTorch — обычно нужен свежий Visual C++ Redistributable
        raise TtsUnavailable("PyTorch DLL: обновите Microsoft Visual C++ Redistributable") from exc
    source = str(LOCAL_MODEL_DIR) if (LOCAL_MODEL_DIR / "model.safetensors").exists() else MODEL_ID
    _tokenizer = AutoTokenizer.from_pretrained(source)
    model = VitsModel.from_pretrained(source)
    model.speaking_rate = SPEAKING_RATE
    model.noise_scale = NOISE_SCALE
    model.noise_scale_duration = NOISE_SCALE_DURATION
    model.eval()
    _model = model


def warm_up() -> None:
    """Загрузить модель заранее (в фоне при старте сервера), чтобы первая фраза не ждала ~30 с."""
    try:
        with _lock:
            _load()
    except TtsUnavailable:
        pass  # голоса нет — сайт обойдётся готовыми файлами


def _split(text: str) -> list[tuple[str, float]]:
    """Текст → [(часть, пауза после неё)]."""
    parts = re.split(r"([,;:—.!?…]+)", normalize(text))
    chunks = []
    for i in range(0, len(parts), 2):
        words = parts[i].strip()
        punct = parts[i + 1] if i + 1 < len(parts) else ""
        pause = max((PAUSES.get(c, 0) for c in punct), default=0.0)
        if words:
            chunks.append((words, pause))
        elif chunks and pause:
            chunks[-1] = (chunks[-1][0], max(chunks[-1][1], pause))
    return chunks


def _synthesize_chunk(words: str, seed: int) -> np.ndarray:
    import torch

    # Символы, которых модель не знает (цифры, латиница), убираем
    vocab = _tokenizer.get_vocab()
    clean = "".join(c for c in words if c in vocab or c == " ").strip()
    if not clean:
        return np.zeros(0, dtype=np.float32)
    torch.manual_seed(seed)
    with torch.no_grad():
        inputs = _tokenizer(clean, return_tensors="pt")
        return _model(**inputs).waveform[0].numpy().astype(np.float32)


def _polish(audio: np.ndarray) -> np.ndarray:
    """Обрезка тишины по краям, выравнивание громкости, мягкие начало и конец."""
    if not audio.size:
        return audio
    threshold = 0.02 * np.abs(audio).max()
    voiced = np.flatnonzero(np.abs(audio) > threshold)
    if voiced.size:
        pad = int(0.03 * SAMPLE_RATE)
        audio = audio[max(0, voiced[0] - pad) : voiced[-1] + pad]
    audio = audio / (np.abs(audio).max() or 1) * 0.89  # пик −1 дБ
    fade = min(int(0.012 * SAMPLE_RATE), len(audio) // 2)
    if fade:
        ramp = np.linspace(0, 1, fade, dtype=np.float32)
        audio[:fade] *= ramp
        audio[-fade:] *= ramp[::-1]
    lead = np.zeros(int(0.08 * SAMPLE_RATE), dtype=np.float32)
    return np.concatenate([lead, audio, lead])


def synthesize(text: str) -> bytes:
    """Текст → WAV (16 кГц, 16 бит, моно)."""
    if not normalize(text):
        raise ValueError("empty text")
    with _lock:
        _load()
        seed = int(cache_key(text), 16) % (2**31)
        pieces = []
        for words, pause in _split(text):
            pieces.append(_synthesize_chunk(words, seed))
            pieces.append(np.zeros(int(pause * SAMPLE_RATE), dtype=np.float32))
    audio = _polish(np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32))

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def cached_wav(text: str) -> Path:
    """Путь к WAV-файлу фразы; генерирует его при первом обращении."""
    folder = get_settings().media_dir / "tts"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{cache_key(text)}.wav"
    if not path.exists():
        data = synthesize(text)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
    return path
