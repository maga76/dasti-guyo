"""Общие фикстуры. Тесты работают на отдельной временной БД и папке media."""

import os
import shutil
import tempfile
from pathlib import Path

import numpy as np
import pytest

# Настройки нужно задать ДО импорта приложения
_tmp = Path(tempfile.mkdtemp(prefix="dasti-guyo-tests-"))
os.environ.update(
    {
        "JWT_SECRET": "test-secret-" + "x" * 40,
        "DATABASE_URL": f"sqlite:///{(_tmp / 'test.db').as_posix()}",
        "MEDIA_DIR": str(_tmp / "media"),
        "CORS_ORIGINS": "http://localhost:5173",
        "LOGIN_RATE_LIMIT": "5",
        "MIN_SAMPLES_PER_GESTURE": "20",
        "TTS_WARM_UP": "false",  # тесты не загружают нейросеть голоса
        "SERVE_FRONTEND": "false",  # иначе неизвестные адреса отдавал бы сайт, а не ошибку 404
    }
)

from fastapi.testclient import TestClient  # noqa: E402

from app.api.routes.auth import login_limiter, register_limiter  # noqa: E402
from app.core.config import FEATURES_PER_FRAME  # noqa: E402
from app.core.database import Base, SessionLocal, engine  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Role, User  # noqa: E402

PASSWORD = "very-secret-pass"


@pytest.fixture(scope="session")
def _app_client():
    # Контекст запускает lifespan — применяются миграции Alembic
    with TestClient(app) as client:
        yield client
    engine.dispose()
    shutil.rmtree(_tmp, ignore_errors=True)


@pytest.fixture
def client(_app_client):
    """Чистая БД и сброшенный лимит входа для каждого теста."""
    with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            conn.execute(table.delete())
    login_limiter.reset()
    register_limiter.reset()
    _app_client.headers.pop("Authorization", None)
    return _app_client


def _create_user(username: str, role: Role) -> None:
    with SessionLocal() as db:
        db.add(User(username=username, password_hash=hash_password(PASSWORD), role=role))
        db.commit()


def _token(client, username: str) -> dict:
    res = client.post("/api/v1/auth/login", data={"username": username, "password": PASSWORD})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


@pytest.fixture
def admin(client) -> dict:
    _create_user("admin", Role.admin)
    return _token(client, "admin")


@pytest.fixture
def contributor(client) -> dict:
    _create_user("volunteer", Role.contributor)
    return _token(client, "volunteer")


def make_frames(n: int = 20, center: float = 0.0, seed: int = 0) -> list[list[float]]:
    """Синтетическая запись одной рукой: форма руки — «центр» класса с шумом,
    запястье около центра кадра, размер ладони 0.1. Вторая рука отсутствует (нули)."""
    rng = np.random.default_rng(seed)
    frames = np.zeros((n, FEATURES_PER_FRAME))
    frames[:, :63] = center + rng.normal(0, 0.05, (n, 63))
    frames[:, 63:65] = rng.normal(0, 0.01, (n, 2))
    frames[:, 65] = 0.1
    return frames.round(4).tolist()


@pytest.fixture
def gesture(client, admin) -> dict:
    res = client.post("/api/v1/gestures", json={"name_tj": "Салом", "name_ru": "Привет"}, headers=admin)
    assert res.status_code == 201, res.text
    return res.json()
