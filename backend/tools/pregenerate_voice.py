"""Заранее озвучивает те же тексты, что и pregenerate_tts.py (app/services/voice.py).
Файлы — frontend/public/audio/<голос>/*.mp3 + index.json.

Запуск из папки backend (нужен интернет); голос — madina (по умолчанию) или achernar:
    $env:PYTHONPATH = "."; .venv\\Scripts\\python tools\\pregenerate_voice.py achernar

Готовые файлы не озвучиваются заново. Кончился лимит — просто запустите снова на следующий день.
"""

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pregenerate_tts import ROOT, texts  # noqa: E402

from app.services import voice  # noqa: E402
from app.services.tts import TtsUnavailable, normalize  # noqa: E402

voice.GEMINI_TIMEOUT = 90.0  # здесь никто не ждёт ответа на странице


def record(text: str, voice_id: str, path: Path) -> bool:
    """Озвучить одну фразу. False — сейчас не получается (лимит или сбой сервиса)."""
    for attempt in range(3):
        try:
            path.write_bytes(voice.synthesize(text, voice_id))
            return True
        except TtsUnavailable as err:
            print(f"    {err}")
            if attempt == 2:
                return False
            # Лимит бывает и поминутным: подождём минуту, прежде чем сдаваться
            time.sleep(65 if voice.gemini_resting() else 10)
            voice.reset_gemini_rest()
    return False


def main() -> None:
    voice_id = sys.argv[1] if len(sys.argv) > 1 else "madina"
    out = ROOT / "frontend" / "public" / "audio" / voice_id
    out.mkdir(parents=True, exist_ok=True)
    index, all_texts, stopped = {}, texts(), False
    for i, text in enumerate(all_texts, 1):
        name = f"{voice.cache_key(text, voice_id)}.mp3"
        path = out / name
        if not path.exists():
            if stopped or not record(text, voice_id, path):
                stopped = True
                continue
        index[normalize(text)] = name
        print(f"[{i}] {text} -> {name} ({path.stat().st_size // 1024} KB)")
    name = voice.GEMINI_VOICE if voice_id == "achernar" else voice.VOICE
    (out / "index.json").write_text(
        json.dumps({"voice": name, "version": voice.VERSION, "files": index}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"Done: {len(index)} of {len(all_texts)} files in {out}")


if __name__ == "__main__":
    main()
