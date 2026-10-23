"""Признаки для модели распознавания жестов (версия 2: модель видит движение).

ЭТОТ ФАЙЛ ДОЛЖЕН СОВПАДАТЬ С frontend/src/dataset/features.js — браузер и сервер
обязаны считать одинаково, иначе модель, обученная в одном месте, не будет работать в другом.

Кадр — 132 числа: два «слота» рук по 66 чисел.
  слот 0 — главная рука, слот 1 — вторая рука.
  Если рук две, главная — та, что ЛЕВЕЕ в исходном (не отзеркаленном) кадре:
  у человека, стоящего лицом к камере, это его правая рука.
  Метки «левая/правая» от MediaPipe не используем: в наборе Slovo их нет,
  а для левшей зеркальное отражение при обучении делает модель симметричной.

  Внутри слота:
    [0..62]  форма руки: 21 точка (x, y, z) относительно запястья, делённые на размер ладони
    [63, 64] положение запястья относительно центра кадра (в долях высоты кадра)
    [65]     размер ладони (запястье → основание среднего пальца, в долях высоты кадра)
  Нет руки — 66 нулей. Признак наличия руки — размер ладони > 0.

Последовательность (вход модели): запись любой длины → SEQ_LEN кадров → нормализация
положения и масштаба по главной руке → SEQ_LEN × 132 чисел подряд.
"""

import math

import numpy as np

POINTS = 21
SLOT = POINTS * 3 + 3  # 66
FRAME = SLOT * 2  # 132
SEQ_LEN = 16
INPUT_SIZE = SEQ_LEN * FRAME  # 2112
LIMIT = 10.0

# Индексы x-координат (для зеркального отражения)
_X_IDX = np.array([s * SLOT + p * 3 for s in (0, 1) for p in range(POINTS)] + [63, SLOT + 63])


def frame_from_hands(hands: list[list[tuple[float, float, float]]], aspect: float) -> list[float]:
    """Руки одного кадра (до двух, по 21 точке в координатах MediaPipe 0..1) → 132 числа.

    aspect = ширина / высота кадра.
    """
    out = [0.0] * FRAME
    # Главная рука — левее в кадре
    ordered = sorted(hands[:2], key=lambda pts: pts[0][0])
    for slot, pts in enumerate(ordered):
        base = slot * SLOT
        wx, wy, wz = pts[0]
        mx, my, mz = pts[9]
        palm = math.hypot((mx - wx) * aspect, my - wy, (mz - wz) * aspect) or 1e-6
        for i, (x, y, z) in enumerate(pts):
            out[base + i * 3] = _clamp((x - wx) * aspect / palm)
            out[base + i * 3 + 1] = _clamp((y - wy) / palm)
            out[base + i * 3 + 2] = _clamp((z - wz) * aspect / palm)
        out[base + 63] = _clamp((wx - 0.5) * aspect)
        out[base + 64] = _clamp(wy - 0.5)
        out[base + 65] = _clamp(palm)
    return out


def _clamp(v: float) -> float:
    return max(-LIMIT, min(LIMIT, v))


def resample(frames: np.ndarray, length: int = SEQ_LEN) -> np.ndarray:
    """Запись любой длины → ровно `length` кадров (ближайший кадр, без смешивания)."""
    n = len(frames)
    if n == 1:
        return np.repeat(frames, length, axis=0)
    idx = np.floor(np.arange(length) * (n - 1) / (length - 1) + 0.5).astype(int)
    return frames[idx]


def sequence_features(frames) -> np.ndarray:
    """Кадры записи (n × 132) → вход модели (SEQ_LEN × 132 = 2112 чисел)."""
    seq = resample(np.asarray(frames, dtype=np.float32)).copy()
    present = seq[:, 65] > 0
    if present.any():
        ref_x = seq[present, 63].mean()
        ref_y = seq[present, 64].mean()
        scale = seq[present, 65].mean()
    else:
        ref_x, ref_y, scale = 0.0, 0.0, 1.0
    scale = scale or 1.0
    for s in (0, 1):
        base = s * SLOT
        has = seq[:, base + 65] > 0
        seq[has, base + 63] = (seq[has, base + 63] - ref_x) / scale
        seq[has, base + 64] = (seq[has, base + 64] - ref_y) / scale
        seq[has, base + 65] = seq[has, base + 65] / scale
    return np.clip(seq, -LIMIT, LIMIT).reshape(-1)


def mirror(frames: np.ndarray) -> np.ndarray:
    """Зеркальное отражение записи (как будто жест показывает левша).

    После отражения главная рука оказывается правее, поэтому слоты меняем местами.
    """
    out = np.array(frames, dtype=np.float32, copy=True)
    has = out[:, 65] > 0
    out[:, _X_IDX] *= -1  # у отсутствующей руки нули так и останутся нулями
    both = has & (out[:, SLOT + 65] > 0)
    out[both] = np.concatenate([out[both, SLOT:], out[both, :SLOT]], axis=1)
    return out


def augment(frames, rng: np.random.Generator) -> np.ndarray:
    """Случайно изменённая копия записи: обрезка по времени, зеркало, шум.

    Помогает модели работать на людях, которых она не видела.
    """
    arr = np.asarray(frames, dtype=np.float32)
    n = len(arr)
    if n >= 8:
        start = rng.integers(0, max(1, int(n * 0.15)) + 1)
        end = n - rng.integers(0, max(1, int(n * 0.15)) + 1)
        arr = arr[start:max(end, start + 4)]
    if rng.random() < 0.5:
        arr = mirror(arr)
    else:
        arr = arr.copy()
    # Шум: форма руки дрожит сильнее, положение запястья — слабо, размер ладони не трогаем.
    # Отсутствующие руки остаются нулями.
    sigma = np.tile(np.r_[np.full(63, 0.03), 0.01, 0.01, 0.0], 2).astype(np.float32)
    present = np.repeat(arr[:, [65, SLOT + 65]] > 0, SLOT, axis=1)
    arr += rng.normal(0, 1, arr.shape).astype(np.float32) * sigma * present
    return arr
