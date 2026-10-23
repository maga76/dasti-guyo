"""Признаки модели: те же формулы реализованы во frontend/src/dataset/features.js."""

import json
from pathlib import Path

import numpy as np

from app.services.features import FRAME, INPUT_SIZE, augment, frame_from_hands, mirror, sequence_features


def hand(cx=0.5, cy=0.6, size=0.1, spread=0.3):
    """Рука: запястье (cx, cy), точка 9 на `size` выше, остальные — веер."""
    pts = [(cx + ((i % 5) - 2) * size * spread, cy - (i // 4 + 1) * size * 0.4, -0.1 * size * i) for i in range(21)]
    pts[0] = (cx, cy, 0.0)
    pts[9] = (cx, cy - size, 0.0)
    return pts


def test_frame_layout():
    f = frame_from_hands([hand()], aspect=1.0)
    assert len(f) == FRAME
    assert f[0] == f[1] == f[2] == 0  # запястье — начало координат
    assert abs(f[9 * 3 + 1] + 1) < 1e-6  # точка 9 на расстоянии одной ладони вверх
    assert abs(f[65] - 0.1) < 1e-6  # размер ладони
    assert all(v == 0 for v in f[66:])  # второй руки нет


def test_primary_hand_is_leftmost():
    right_in_image = hand(cx=0.7, spread=0.1)
    left_in_image = hand(cx=0.3, spread=0.5)
    a = frame_from_hands([right_in_image, left_in_image], 1.0)
    b = frame_from_hands([left_in_image, right_in_image], 1.0)
    assert a == b  # порядок рук от MediaPipe не важен
    assert abs(a[63] - (0.3 - 0.5)) < 1e-6  # главная — левее в кадре


def test_sequence_is_position_and_scale_invariant():
    near = [frame_from_hands([hand(0.4 + i * 0.01, 0.6, 0.1)], 1.0) for i in range(30)]
    far = [frame_from_hands([hand(0.6 + i * 0.005, 0.5, 0.05)], 1.0) for i in range(30)]
    a, b = sequence_features(near), sequence_features(far)
    assert a.shape == (INPUT_SIZE,)
    np.testing.assert_allclose(a, b, atol=1e-4)


def test_mirror_twice_is_identity_and_keeps_missing_hand_zero():
    frames = np.array([frame_from_hands([hand()], 4 / 3), frame_from_hands([hand(0.3), hand(0.7)], 4 / 3)])
    np.testing.assert_allclose(mirror(mirror(frames)), frames, atol=1e-6)
    assert np.all(mirror(frames)[0, 66:] == 0)


def test_augment_keeps_shape_and_zeros():
    frames = np.array([frame_from_hands([hand()], 1.0) for _ in range(40)])
    out = augment(frames, np.random.default_rng(0))
    assert out.shape[1] == FRAME and 4 <= len(out) <= 40
    assert np.all(out[:, 66:] == 0)


def test_writes_fixture_for_frontend():
    """Сохраняет пример для проверки, что браузер считает так же (tests/selftest.html)."""
    hands_seq = [[hand(0.4 + i * 0.01, 0.6 - i * 0.004, 0.1)] + ([hand(0.75, 0.55)] if i % 3 else []) for i in range(23)]
    aspect = 9 / 16
    frames = [frame_from_hands(h, aspect) for h in hands_seq]
    out = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "fixtures" / "features-v2.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "aspect": aspect,
                "hands": [[[list(p) for p in h] for h in hs] for hs in hands_seq],
                "frames": frames,
                "sequence": sequence_features(frames).tolist(),
            }
        ),
        encoding="utf-8",
    )
