"""Заранее озвучивает все известные слова и быстрые фразы таджикским голосом.

Файлы кладутся в frontend/public/audio/tts/ вместе с index.json (текст → файл).
Так голос работает на сайте без интернета и без сервера.

Запуск из папки backend (нужны пакеты из requirements-tts.txt):
    $env:PYTHONPATH = "."; .venv\\Scripts\\python tools\\pregenerate_tts.py
"""

import json
from pathlib import Path

from app.scripts.seed import QUICK_PHRASES
from app.services import tts

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "frontend" / "public" / "audio" / "tts"
BASE_DATASET = ROOT / "frontend" / "public" / "datasets" / "slovo-base.json"


def texts() -> list[str]:
    words = []
    if BASE_DATASET.exists():
        base = json.loads(BASE_DATASET.read_text(encoding="utf-8"))
        words = [label for label in base["labels"] if label != "__none__"]
    phrases = [tj for tj, _ in QUICK_PHRASES]
    # Правила сборки предложений — чтобы готовые фразы звучали целиком и без сервера
    rules_file = ROOT / "frontend" / "public" / "data" / "phrases.json"
    rules = [p["text_tj"] for p in json.loads(rules_file.read_text(encoding="utf-8"))["phrases"]] if rules_file.exists() else []
    return list(dict.fromkeys(words + phrases + rules))  # без повторов, порядок сохраняется


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    index = {}
    for i, text in enumerate(texts(), 1):
        name = f"{tts.cache_key(text)}.wav"
        path = OUT / name
        if not path.exists():
            path.write_bytes(tts.synthesize(text))
        index[tts.normalize(text)] = name
        print(f"[{i}] {text} → {name} ({path.stat().st_size // 1024} КБ)")
    (OUT / "index.json").write_text(
        json.dumps({"voice": tts.MODEL_ID, "version": tts.VOICE_VERSION, "files": index}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"Готово: {len(index)} файлов в {OUT}")


if __name__ == "__main__":
    main()
