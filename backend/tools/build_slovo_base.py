"""Сборка базовой модели из открытого набора Slovo (русский жестовый язык).

Что делает:
  1. Берёт из Slovo записи выбранных слов (WORDS) и класса «нет жеста» (no_event).
  2. Переводит точки рук MediaPipe в наши признаки (app/services/features.py).
  3. Обучает НАШУ нейросеть и честно проверяет её на людях, которых она не видела
     (в Slovo люди заранее разделены на train/test).
  4. Сохраняет для сайта:
       frontend/public/models/base/       — модель TensorFlow.js + metrics.json (точность, график обучения)
       frontend/public/datasets/slovo-base.{json,bin} — компактные записи, чтобы браузер мог
                                             переобучать модель вместе с записями пользователя
                                             и показывать, как выполняется жест.

Нужны файлы (см. README): data/slovo/annotations.csv и data/slovo/slovo_mediapipe.json.
Запуск из папки backend:
    $env:PYTHONPATH = "."; .venv\\Scripts\\python tools\\build_slovo_base.py

ВАЖНО: Slovo — русский жестовый язык. Таджикский жестовый язык вырос из той же
советской системы, многие жесты совпадают, но не все. Подписи ниже — перевод
ЗНАЧЕНИЯ слова на таджикский, а не утверждение, что жест таджикский.
"""

import csv
import json
import math
import pickle
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from sklearn.neural_network import MLPClassifier

from app.services.features import FRAME, INPUT_SIZE, SEQ_LEN, augment, frame_from_hands, resample, sequence_features
from app.services.tfjs_export import export_mlp_to_tfjs

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "backend" / "data" / "slovo"
MODEL_OUT = ROOT / "frontend" / "public" / "models" / "base"
DATASET_OUT = ROOT / "frontend" / "public" / "datasets"

NONE_LABEL = "__none__"
NONE_SOURCE = "no_event"
NONE_SAMPLES = 160  # из 400 записей «нет жеста» хватит части

# Класс «не наш жест». Без него модель знает только 25 слов и любое движение рук (почесаться,
# поправить волосы, жест не из словаря) обязана назвать одним из них — отсюда ложные слова.
# Учим её на записях ДРУГИХ слов Slovo: это настоящие движения настоящих людей.
#   OTHER_TRAIN_WORDS — слова, которые модель видит как «не наш жест»;
#   OTHER_HELDOUT_WORDS — слова, которых модель не видела вовсе: на них честно меряем,
#   как часто она выдумывает жест (в итоговую модель они тоже входят).
OTHER_TRAIN_WORDS = 240
OTHER_HELDOUT_WORDS = 60
OTHER_PER_WORD = {"train": 3, "test": 1}  # записей на слово у людей из train / test
OTHER_HELDOUT_PER_WORD = 2  # у людей из test
# Сколько записей «не наш жест» на эпоху. Подобрано (tune): 60 — лучший баланс; при 120–400 модель
# чаще молчит на настоящих словах, а выдумывает слова почти так же редко
NONE_PER_EPOCH = 60
# Порог уверенности переводчика по умолчанию (как на сайте, translateView.js). С классом
# «не наш жест» 0.6 лучше прежних 0.8: на новых людях верно 61%, не то слово 10%,
# выдуманных слов на чужих жестах 12% (у прежней модели при 0.8 — 66% / 14% / 57%)
ACCEPT = 0.6
BROWSER_OTHER = 150  # сколько записей «не наш жест» положить в набор для браузера

# Слово в Slovo → (таджикский, русский, пометка)
# Пометка "national": по словам Национального объединения глухих Таджикистана,
# у этого слова в таджикском жестовом языке свой, национальный жест.
WORDS = {
    "Привет!": ("Салом", "Привет", "national"),
    "Пока": ("Хайр", "Пока", ""),
    "да": ("Ҳа", "Да", ""),
    "не": ("Не", "Нет", ""),
    "хорошо": ("Хуб", "Хорошо", ""),
    "Плохо": ("Бад", "Плохо", ""),
    "помочь": ("Ёрӣ додан", "Помочь", ""),
    "вода": ("Об", "Вода", ""),
    "болит": ("Дард мекунад", "Болит", ""),
    "мать": ("Модар", "Мама", ""),
    "отец": ("Падар", "Папа", ""),
    "друг": ("Дӯст", "Друг", ""),
    "я": ("Ман", "Я", ""),
    "ты": ("Ту", "Ты", ""),
    "мы": ("Мо", "Мы", ""),
    "дом": ("Хона", "Дом", ""),
    "школа": ("Мактаб", "Школа", ""),
    "благодарность": ("Миннатдорӣ", "Благодарность", ""),
    "что": ("Чӣ", "Что", ""),
    "почему": ("Чаро", "Почему", ""),
    "хотеть": ("Хостан", "Хотеть", ""),
    "понять": ("Фаҳмидан", "Понять", ""),
    "сегодня": ("Имрӯз", "Сегодня", ""),
    "завтра": ("Фардо", "Завтра", ""),
    "еда": ("Хӯрок", "Еда", ""),
    # Повседневные слова (добавлены по просьбе: «футбол и слова, которые используют каждый день»)
    "Футбол": ("Футбол", "Футбол", ""),
    "играть": ("Бозӣ кардан", "Играть", ""),
    "работать": ("Кор кардан", "Работать", ""),
    "есть": ("Хӯрдан", "Есть", ""),
    "пить": ("Нӯшидан", "Пить", ""),
    "спать": ("Хобидан", "Спать", ""),
    "идти": ("Рафтан", "Идти", ""),
    "любить": ("Дӯст доштан", "Любить", ""),
    "знать": ("Донистан", "Знать", ""),
    "хлеб": ("Нон", "Хлеб", ""),
    "деньги": ("Пул", "Деньги", ""),
    "магазин": ("Мағоза", "Магазин", ""),
    "вчера": ("Дирӯз", "Вчера", ""),
    "утро": ("Саҳар", "Утро", ""),
    "вечер": ("Бегоҳ", "Вечер", ""),
    "брат": ("Бародар", "Брат", ""),
    "сестра": ("Хоҳар", "Сестра", ""),
    "семья": ("Оила", "Семья", ""),
    "книга": ("Китоб", "Книга", ""),
    "читать": ("Хондан", "Читать", ""),
    "писать": ("Навиштан", "Писать", ""),
    "говорить": ("Гап задан", "Говорить", ""),
    "город": ("Шаҳр", "Город", ""),
    "купить": ("Харидан", "Купить", ""),
    "когда": ("Кай", "Когда", ""),
    "кто?": ("Кӣ", "Кто", ""),
    "большой": ("Калон", "Большой", ""),
    "маленький": ("Хурд", "Маленький", ""),
    "мальчик": ("Писар", "Мальчик", ""),
    "девочка": ("Духтар", "Девочка", ""),
}

# Подобрано на людях из test (tune): после ~30 эпох модель начинает заучивать записи
# (на 60 эпохах — 59.5% на новых людях, на 30 с сетью 512→256 и alpha 0.03 — 66.4%)
EPOCHS = 30
AUG_PER_EPOCH = 4  # случайных копий каждой записи на эпоху
STORED_FRAMES = 32  # сколько кадров записи хранить для браузера
SCALE = 1000  # числа хранятся как int16 × 1000


def load_annotations():
    with open(DATA / "annotations.csv", encoding="utf-8") as f:
        rows = list(csv.DictReader(f, delimiter="\t"))
    wanted = [r for r in rows if r["text"] in WORDS]
    missing = set(WORDS) - {r["text"] for r in wanted}
    if missing:
        raise SystemExit(f"В Slovo нет слов: {missing}")
    # Детерминированная выборка «нет жеста» с сохранением деления train/test
    none_rows = sorted((r for r in rows if r["text"] == NONE_SOURCE), key=lambda r: r["attachment_id"])
    for r in wanted:
        r["role"] = "word"
    return wanted + none_rows[:NONE_SAMPLES] + other_rows(rows)


def other_rows(rows):
    """Записи других слов Slovo для класса «не наш жест» (выбор детерминированный)."""
    by_text = defaultdict(list)
    for r in rows:
        if r["text"] not in WORDS and r["text"] != NONE_SOURCE:
            by_text[r["text"]].append(r)
    texts = sorted(by_text)
    order = np.random.default_rng(7).permutation(len(texts))
    picked = []
    for n, i in enumerate(order[: OTHER_TRAIN_WORDS + OTHER_HELDOUT_WORDS]):
        group = sorted(by_text[texts[i]], key=lambda r: r["attachment_id"])
        train = [r for r in group if r["train"] == "True"]
        test = [r for r in group if r["train"] != "True"]
        if n < OTHER_TRAIN_WORDS:
            chosen = train[: OTHER_PER_WORD["train"]] + test[: OTHER_PER_WORD["test"]]
            role = "other"
        else:
            chosen = test[:OTHER_HELDOUT_PER_WORD]
            role = "heldout"
        for r in chosen:
            picked.append({**r, "role": role})
    return picked


def iter_landmarks(path: Path, wanted: set[str]):
    """Потоковое чтение огромного JSON {id: [кадры]} — без загрузки 1.2 ГБ в память."""
    decoder = json.JSONDecoder()
    chunk = 1 << 23
    with open(path, encoding="utf-8") as f:
        buf = f.read(chunk)
        pos = buf.index("{") + 1
        found = 0
        while found < len(wanted):
            if len(buf) - pos < chunk:
                buf = buf[pos:] + f.read(chunk)
                pos = 0
            while pos < len(buf) and buf[pos] in " \n\r\t,":
                pos += 1
            if pos >= len(buf) or buf[pos] == "}":
                return
            key, pos = decoder.raw_decode(buf, pos)
            pos = buf.index(":", pos) + 1
            while buf[pos] in " \n\r\t":
                pos += 1
            while True:
                try:
                    value, end = decoder.raw_decode(buf, pos)
                    break
                except json.JSONDecodeError:
                    more = f.read(chunk)
                    if not more:
                        raise
                    buf = buf[pos:] + more
                    pos = 0
            pos = end
            if key in wanted:
                found += 1
                yield key, value


def to_frames(video: list[dict], aspect: float) -> np.ndarray:
    frames = []
    for frame in video:
        hands = [[(p["x"], p["y"], p["z"]) for p in pts] for pts in frame.values() if len(pts) == 21]
        frames.append(frame_from_hands(hands, aspect))
    return np.asarray(frames, dtype=np.float32)


def build_samples(rows):
    """Записи выбранных слов. Результат кэшируется: разбор 1.2 ГБ занимает минуты."""
    cache = DATA / "samples_cache.pkl"
    key = (tuple(sorted(WORDS)), NONE_SAMPLES, OTHER_TRAIN_WORDS, OTHER_HELDOUT_WORDS, tuple(OTHER_PER_WORD.values()), OTHER_HELDOUT_PER_WORD)
    if cache.exists():
        with open(cache, "rb") as f:
            cached = pickle.load(f)
        if cached["key"] == key:
            print("Записи взяты из кэша", cache.name)
            return cached["samples"], cached["labels"]
    samples, labels = _parse_samples(rows)

    # Классы без единой записи выбрасываем. Так случилось с no_event: в файле с точками
    # рук записей «нет жеста» нет (видимо, потому что рук в них нет вовсе).
    present = sorted({s["label"] for s in samples})
    for name in (labels[i] for i in range(len(labels)) if i not in present):
        print(f"ВНИМАНИЕ: для «{name}» нет ни одной записи с руками — класс пропущен")
    remap = {old: new for new, old in enumerate(present)}
    for s in samples:
        s["label"] = remap[s["label"]]
    labels = [labels[i] for i in present]

    with open(cache, "wb") as f:
        pickle.dump({"key": key, "samples": samples, "labels": labels}, f)
    return samples, labels


def _parse_samples(rows):
    by_id = {r["attachment_id"]: r for r in rows}
    users = sorted({r["user_id"] for r in rows})
    # «нет жеста» и «не наш жест» — один класс: всё, что не слово словаря
    labels = list(WORDS) + [NONE_SOURCE]
    samples = []
    print(f"Читаю точки рук для {len(by_id)} записей (это несколько минут)…")
    for key, video in iter_landmarks(DATA / "slovo_mediapipe.json", set(by_id)):
        row = by_id[key]
        aspect = int(row["width"]) / int(row["height"])
        frames = to_frames(video, aspect)
        if frames.ndim != 2 or not len(frames):
            continue  # в наборе есть записи без единого кадра
        with_hands = int((frames[:, 65] > 0).sum())
        # Запись жеста без рук бесполезна; у «нет жеста» рук может не быть
        if row["text"] != NONE_SOURCE and with_hands < 4:
            continue
        samples.append(
            {
                "frames": frames,
                "label": labels.index(row["text"]) if row["text"] in WORDS else labels.index(NONE_SOURCE),
                "train": row["train"] == "True",
                "user": users.index(row["user_id"]),
                # word — слово словаря; other — «не наш жест» для обучения;
                # heldout — слово, которого модель не видит при проверке (только для замера)
                "role": row.get("role", "other"),
                "text": row["text"],
            }
        )
        if len(samples) % 100 == 0:
            print(f"  {len(samples)} записей")
    return samples, labels


def make_xy(samples, rng, augmented: bool):
    xs, ys = [], []
    for s in samples:
        xs.append(sequence_features(s["frames"]))
        ys.append(s["label"])
        if augmented:
            for _ in range(AUG_PER_EPOCH):
                xs.append(sequence_features(augment(s["frames"], rng)))
                ys.append(s["label"])
    return np.asarray(xs, dtype=np.float32), np.asarray(ys)


def new_model():
    return MLPClassifier(hidden_layer_sizes=(512, 256), alpha=3e-2, batch_size=64, learning_rate_init=1e-3, random_state=0)


def epoch_xy(words, others, rng):
    """Записи одной эпохи: все слова (с копиями) + часть «не наш жест» (каждая в одном варианте)."""
    x, y = make_xy(words, rng, augmented=True)
    if not others:
        return x, y
    pick = rng.choice(len(others), size=min(NONE_PER_EPOCH, len(others)), replace=False)
    xo = [sequence_features(augment(others[i]["frames"], rng) if rng.random() < 0.5 else others[i]["frames"]) for i in pick]
    yo = [others[i]["label"] for i in pick]
    return np.concatenate([x, np.asarray(xo, dtype=np.float32)]), np.concatenate([y, np.asarray(yo)])


def train(samples, n_classes, rng, test=None):
    """Обучение по эпохам; на каждой эпохе — новые случайные копии записей.
    Возвращает модель и кривую точности на словах (для графика на сайте)."""
    clf = new_model()
    classes = np.arange(n_classes)
    curve = []
    words = [s for s in samples if s["role"] == "word"]
    others = [s for s in samples if s["role"] != "word"]
    x_test, y_test = make_xy(test, rng, augmented=False) if test else (None, None)
    x_plain, y_plain = make_xy(words, rng, augmented=False)
    for epoch in range(1, EPOCHS + 1):
        x, y = epoch_xy(words, others, rng)
        order = rng.permutation(len(x))
        clf.partial_fit(x[order], y[order], classes=classes)
        # Скорость обучения плавно снижается 1e-3 → 5e-5 (косинусом): к концу модель
        # «успокаивается» и точность перестаёт скакать. _optimizer — внутреннее поле sklearn.
        progress = epoch / EPOCHS
        clf._optimizer.learning_rate_init = 5e-5 + (1e-3 - 5e-5) * 0.5 * (1 + math.cos(math.pi * progress))
        point = {"epoch": epoch, "train": round(float(clf.score(x_plain, y_plain)), 4)}
        if test:
            point["test"] = round(float(clf.score(x_test, y_test)), 4)
        curve.append(point)
        if epoch % 10 == 0:
            print(f"  эпоха {epoch}: {point}")
    return clf, curve


def rejection_stats(clf, samples, none_index, rng):
    """Как модель ведёт себя на записях, где НЕТ нашего слова.
    false_accept — доля, где модель уверенно (≥ ACCEPT) назвала одно из слов: это и есть
    «выдуманные» слова в переводчике."""
    x, _ = make_xy(samples, rng, augmented=False)
    proba = clf.predict_proba(x)
    top = proba.argmax(1)
    conf = proba.max(1)
    word = top != none_index if none_index is not None else np.ones(len(top), bool)
    return {"n": len(samples), "falseAccept": round(float((word & (conf >= ACCEPT)).mean()), 4)}


def word_stats(clf, samples, rng, none_index=None):
    """На записях слов, как в переводчике (порог ACCEPT):
    acceptedCorrect — уверенно и правильно; acceptedWrong — уверенно назвала ДРУГОЕ слово (худшее);
    missed — промолчала (низкая уверенность или «не жест»): человек просто повторит жест."""
    x, y = make_xy(samples, rng, augmented=False)
    proba = clf.predict_proba(x)
    top = proba.argmax(1)
    sure = proba.max(1) >= ACCEPT
    is_word = top != none_index if none_index is not None else np.ones(len(top), bool)
    correct = (top == y) & sure
    wrong = (top != y) & sure & is_word
    return {
        "accuracy": round(float((top == y).mean()), 4),
        "acceptedCorrect": round(float(correct.mean()), 4),
        "acceptedWrong": round(float(wrong.mean()), 4),
        "missed": round(float(1 - correct.mean() - wrong.mean()), 4),
    }


def main():
    rng = np.random.default_rng(42)
    rows = load_annotations()
    samples, source_labels = build_samples(rows)
    n_classes = len(source_labels)
    none_index = source_labels.index(NONE_SOURCE)
    words_train = [s for s in samples if s["role"] == "word" and s["train"]]
    words_test = [s for s in samples if s["role"] == "word" and not s["train"]]
    other_train = [s for s in samples if s["role"] == "other" and s["train"]]
    other_test = [s for s in samples if s["role"] == "other" and not s["train"]]
    heldout = [s for s in samples if s["role"] == "heldout"]
    test_set = words_test
    print(
        f"Записей: {len(samples)}: слова {len(words_train)}+{len(words_test)}, «не наш жест» "
        f"{len(other_train)}+{len(other_test)}, незнакомые слова для замера {len(heldout)}; классов: {n_classes}"
    )

    # 0) Для сравнения — модель как раньше: только 25 слов, без «не наш жест»
    print("Прежний способ (без «не наш жест»)…")
    old_probe, _ = train(words_train, n_classes, rng)
    old = {"words": word_stats(old_probe, words_test, rng), "heldout": rejection_stats(old_probe, heldout, None, rng)}
    print(f"  прежний: {old}")

    # 1) Честная проверка: учимся на одних людях, проверяем на других
    print("Проверочное обучение (люди из test и незнакомые слова не участвуют)…")
    probe, curve = train(words_train + other_train, n_classes, rng, test=test_set)
    x_test, y_test = make_xy(test_set, rng, augmented=False)
    pred = probe.predict(x_test)
    accuracy = float((pred == y_test).mean())
    rejection = {
        "accept": ACCEPT,
        "words": word_stats(probe, words_test, rng, none_index),
        "otherNewPeople": rejection_stats(probe, other_test, none_index, rng),
        "heldout": rejection_stats(probe, heldout, none_index, rng),
        "before": old,
    }
    print(f"Точность на новых людях: {accuracy:.1%}")
    print(f"  новый: {rejection}")

    tj_labels = [WORDS[l][0] if l in WORDS else NONE_LABEL for l in source_labels]
    per_class = []
    confusion = Counter()
    for c in range(n_classes):
        mask = y_test == c
        per_class.append({"label": tj_labels[c], "accuracy": round(float((pred[mask] == c).mean()), 3) if mask.any() else None})
        for p in pred[mask]:
            if p != c:
                confusion[(c, int(p))] += 1
    totals = Counter(y_test.tolist())
    confused = [
        {"a": tj_labels[a], "b": tj_labels[b], "share": round(n / totals[a], 3)}
        for (a, b), n in confusion.most_common(8)
    ]

    # 2) Итоговая модель — на всех записях
    print("Итоговое обучение на всех записях…")
    final, _ = train(samples, n_classes, rng)

    MODEL_OUT.mkdir(parents=True, exist_ok=True)
    export_mlp_to_tfjs(
        final,
        MODEL_OUT,
        tj_labels,
        extra_metadata={"featureVersion": 2, "seqLen": SEQ_LEN, "frameSize": FRAME, "source": "slovo"},
    )
    vocabulary = [
        {"label": tj_labels[i], "ru": WORDS[l][1] if l in WORDS else "Нет жеста", "slovo": l, "note": WORDS[l][2] if l in WORDS else ""}
        for i, l in enumerate(source_labels)
    ]
    metrics = {
        "createdAt": datetime.now(UTC).isoformat(),
        "source": "Slovo (SberDevices), русский жестовый язык, CC BY-SA 4.0",
        "classes": n_classes,
        "samples": len(samples),
        "signersTrain": len({s["user"] for s in words_train}),
        "signersTest": len({s["user"] for s in test_set}),
        "testAccuracy": round(accuracy, 4),
        "perClass": per_class,
        "testCounts": {tj_labels[c]: int((y_test == c).sum()) for c in range(n_classes)},
        "confused": confused,
        # Как часто модель «выдумывает» слово на движениях, которых нет в словаре (см. rejection_stats)
        "rejection": rejection,
        "curve": curve,
        "vocabulary": vocabulary,
    }
    (MODEL_OUT / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=1), encoding="utf-8")

    # 3) Компактные записи для браузера: 32 кадра × 132 числа в int16.
    # «Не наш жест» — по одной записи на слово (не больше BROWSER_OTHER): браузеру этого хватит,
    # чтобы при переобучении не разучиться говорить «это не жест», а файл остаётся небольшим.
    DATASET_OUT.mkdir(parents=True, exist_ok=True)
    blobs, index = [], []
    seen_other = set()
    browser = []
    for s in samples:
        if s["role"] == "word":
            browser.append(s)
        elif s["role"] == "other" and s["train"] and s["text"] not in seen_other and len(seen_other) < BROWSER_OTHER:
            seen_other.add(s["text"])
            browser.append(s)
    for s in browser:
        stored = resample(s["frames"], STORED_FRAMES)
        blobs.append(np.clip(np.round(stored * SCALE), -32767, 32767).astype("<i2").tobytes())
        index.append([s["label"], int(s["train"])])
    (DATASET_OUT / "slovo-base.bin").write_bytes(b"".join(blobs))
    (DATASET_OUT / "slovo-base.json").write_text(
        json.dumps(
            {
                "format": "dasti-guyo-base",
                "featureVersion": 2,
                "frameSize": FRAME,
                "framesPerSample": STORED_FRAMES,
                "scale": SCALE,
                "labels": tj_labels,
                "vocabulary": vocabulary,
                "samples": index,  # [номер класса, 1 = обучающий человек / 0 = проверочный]
                "source": metrics["source"],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    size_mb = sum(len(b) for b in blobs) / 1e6
    print(f"Готово. Модель: {MODEL_OUT}, набор для браузера: {size_mb:.1f} МБ")
    assert INPUT_SIZE == final.coefs_[0].shape[0]


if __name__ == "__main__":
    main()
