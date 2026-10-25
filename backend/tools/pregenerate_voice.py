"""Заранее озвучивает те же тексты, что и pregenerate_tts.py, женским голосом «Мадина»
(app/services/voice.py). Файлы — frontend/public/audio/madina/*.mp3 + index.json.

Запуск из папки backend (нужен пакет edge-tts и интернет):
    $env:PYTHONPATH = "."; .venv\\Scripts\\python tools\\pregenerate_voice.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pregenerate_tts import ROOT, texts  # noqa: E402

from app.services import voice  # noqa: E402
from app.services.tts import normalize  # noqa: E402

OUT = ROOT / "frontend" / "public" / "audio" / "madina"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    index = {}
    for i, text in enumerate(texts(), 1):
        name = f"{voice.cache_key(text)}.mp3"
        path = OUT / name
        if not path.exists():
            path.write_bytes(voice.synthesize(text))
        index[normalize(text)] = name
        print(f"[{i}] {text} -> {name} ({path.stat().st_size // 1024} KB)")
    (OUT / "index.json").write_text(
        json.dumps({"voice": voice.VOICE, "version": voice.VERSION, "files": index}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"Done: {len(index)} files in {OUT}")


if __name__ == "__main__":
    main()
