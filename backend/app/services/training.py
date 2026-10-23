"""Обучение модели распознавания жестов на сервере.

Модель смотрит на ДВИЖЕНИЕ: запись жеста приводится к 16 кадрам по 132 числа
(app/services/features.py) — это и есть один пример для обучения. Чтобы модель
лучше работала на новых людях, каждая запись дополняется случайными копиями
(обрезка по времени, зеркало, шум).

Обучение идёт в отдельном потоке и не блокирует сервер. Одновременно —
только одно обучение.
"""

import logging
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Lock

import numpy as np
from sklearn.model_selection import StratifiedKFold
from sklearn.neural_network import MLPClassifier
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import FEATURES_PER_FRAME, get_settings
from app.core.database import SessionLocal
from app.core.errors import AppError
from app.models import Gesture, ModelVersion, Sample
from app.schemas.models import TrainStatus
from app.services.features import SEQ_LEN, augment, sequence_features
from app.services.tfjs_export import export_mlp_to_tfjs

log = logging.getLogger(__name__)


def _percent(value: float) -> str:
    return f"{value * 100:.1f}%"


def publish_model(db: Session, model: ModelVersion, force: bool = False) -> ModelVersion:
    """Публикует модель. Если она хуже текущей опубликованной — ошибка (если не force)."""
    current = db.scalar(select(ModelVersion).where(ModelVersion.is_published.is_(True)))
    if current and current.id != model.id and not force and model.accuracy < current.accuracy:
        raise AppError(
            409, "model_worse", new=_percent(model.accuracy), current=_percent(current.accuracy)
        )
    for other in db.scalars(select(ModelVersion).where(ModelVersion.is_published.is_(True))):
        other.is_published = False
    model.is_published = True
    db.commit()
    db.refresh(model)
    return model


def check_dataset(db: Session) -> list[Gesture]:
    """Проверяет, что данных хватает. Возвращает жесты-классы в порядке выходов модели."""
    min_samples = get_settings().min_samples_per_gesture
    rows = db.execute(
        select(Gesture, func.count(Sample.id))
        .join(Sample, (Sample.gesture_id == Gesture.id) & Sample.is_approved.is_(True))
        .where(Gesture.is_active.is_(True))
        .group_by(Gesture.id)
        .order_by(Gesture.id)
    ).all()

    too_few = [
        {"gesture_id": g.id, "name_tj": g.name_tj, "approved": n} for g, n in rows if n < min_samples
    ]
    if too_few:
        raise AppError(400, "not_enough_samples", errors=too_few, min=min_samples)
    if len(rows) < 2:
        raise AppError(400, "not_enough_gestures")
    return [g for g, _ in rows]


AUGMENT_COPIES = 6


def _load_dataset(db: Session, gestures: list[Gesture]):
    """Записи (кадры n × 132) и номера классов."""
    index = {g.id: i for i, g in enumerate(gestures)}
    records, labels = [], []
    query = select(Sample.gesture_id, Sample.landmarks).where(
        Sample.is_approved.is_(True), Sample.gesture_id.in_(index)
    )
    for gesture_id, frames in db.execute(query):
        records.append(np.asarray(frames, dtype=np.float32).reshape(-1, FEATURES_PER_FRAME))
        labels.append(index[gesture_id])
    return records, np.asarray(labels)


def _to_xy(records, labels, rng: np.random.Generator | None):
    """Признаки последовательностей; с rng — плюс случайные копии каждой записи."""
    xs, ys = [], []
    for frames, label in zip(records, labels):
        xs.append(sequence_features(frames))
        ys.append(label)
        for _ in range(AUGMENT_COPIES if rng is not None else 0):
            xs.append(sequence_features(augment(frames, rng)))
            ys.append(label)
    return np.asarray(xs, dtype=np.float32), np.asarray(ys)


def _new_classifier() -> MLPClassifier:
    # 2112 входов (16 кадров × 132) → 256 → 128 → классы
    return MLPClassifier(
        hidden_layer_sizes=(256, 128),
        activation="relu",
        alpha=1e-3,
        batch_size=64,
        learning_rate_init=1e-3,
        max_iter=150,
        random_state=42,
    )


def train_and_export(db: Session, gestures: list[Gesture], on_progress=lambda p, m: None) -> ModelVersion:
    """Обучает модель, сохраняет файлы TF.js и запись ModelVersion (не опубликована)."""
    settings = get_settings()
    on_progress(0.1, "Бор кардани маълумот / Загрузка данных")
    records, labels = _load_dataset(db, gestures)
    rng = np.random.default_rng(42)

    # Проверка точности на записях, которых модель не видела (их копии в обучение не попадают)
    on_progress(0.3, "Санҷиши дақиқӣ / Проверка точности")
    train_idx, test_idx = next(
        StratifiedKFold(n_splits=5, shuffle=True, random_state=42).split(np.zeros(len(labels)), labels)
    )
    x_train, y_train = _to_xy([records[i] for i in train_idx], labels[train_idx], rng)
    x_test, y_test = _to_xy([records[i] for i in test_idx], labels[test_idx], None)
    accuracy = float(_new_classifier().fit(x_train, y_train).score(x_test, y_test))

    # Итоговая модель учится на всех данных
    on_progress(0.6, "Омӯзиши модели / Обучение модели")
    clf = _new_classifier().fit(*_to_xy(records, labels, rng))

    on_progress(0.9, "Захира кардан / Сохранение")
    version = (db.scalar(select(func.max(ModelVersion.version))) or 0) + 1
    out_dir = settings.models_dir / f"v{version}"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    labels = [g.name_tj for g in gestures]
    export_mlp_to_tfjs(
        clf, out_dir, labels, extra_metadata={"featureVersion": 2, "seqLen": SEQ_LEN, "frameSize": FEATURES_PER_FRAME}
    )

    model = ModelVersion(
        version=version,
        accuracy=accuracy,
        gesture_list=[
            {"id": g.id, "name_tj": g.name_tj, "name_ru": g.name_ru, "category": g.category}
            for g in gestures
        ],
        file_path=f"models/v{version}/model.json",
    )
    db.add(model)
    db.commit()
    db.refresh(model)
    return model


class TrainingManager:
    """Запускает обучение в фоне и хранит его состояние."""

    def __init__(self):
        self._lock = Lock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="training")
        self.status = TrainStatus(state="idle")

    def start(self, db: Session, auto_publish: bool) -> TrainStatus:
        with self._lock:
            if self.status.state == "running":
                raise AppError(409, "training_running")
            gestures = check_dataset(db)  # понятная ошибка сразу, а не в фоне
            gesture_ids = [g.id for g in gestures]
            self.status = TrainStatus(
                state="running", message="Оғоз / Старт", started_at=datetime.now(UTC)
            )
        self._executor.submit(self._run, gesture_ids, auto_publish)
        return self.status

    def _progress(self, progress: float, message: str):
        self.status = self.status.model_copy(update={"progress": progress, "message": message})

    def _run(self, gesture_ids: list[int], auto_publish: bool):
        with SessionLocal() as db:
            try:
                gestures = [db.get(Gesture, gid) for gid in gesture_ids]
                model = train_and_export(db, gestures, self._progress)
                published = False
                if auto_publish:
                    try:
                        publish_model(db, model)
                        published = True
                    except AppError:
                        pass  # новая модель хуже — остаётся неопубликованной
                self.status = self.status.model_copy(
                    update={
                        "state": "done",
                        "progress": 1.0,
                        "message": "Тайёр / Готово",
                        "finished_at": datetime.now(UTC),
                        "model_version_id": model.id,
                        "accuracy": model.accuracy,
                        "published": published,
                    }
                )
            except Exception as exc:  # noqa: BLE001 — любую ошибку показываем в статусе
                log.exception("Ошибка обучения")
                self.status = self.status.model_copy(
                    update={
                        "state": "failed",
                        "message": f"Хато / Ошибка: {exc}",
                        "finished_at": datetime.now(UTC),
                    }
                )

    def wait(self, timeout: float = 60) -> None:
        """Дождаться окончания текущего обучения (используется в тестах)."""
        self._executor.submit(lambda: None).result(timeout=timeout)


training_manager = TrainingManager()
