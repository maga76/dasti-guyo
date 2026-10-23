"""Настройки приложения. Значения берутся из переменных окружения и файла .env."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[2]  # папка backend/

# Формат одного кадра — 132 числа: две руки по 66 (форма руки 21×(x,y,z) относительно
# запястья + положение запястья + размер ладони). Подробно: app/services/features.py.
POINTS_PER_HAND = 21
FEATURES_PER_FRAME = 2 * (POINTS_PER_HAND * 3 + 3)  # 132

# Категория служебного класса «нет жеста»
NONE_CATEGORY = "system"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    app_name: str = "Дасти Гӯё API"
    database_url: str = f"sqlite:///{(BASE_DIR / 'data' / 'app.db').as_posix()}"
    # Применять миграции Alembic при старте сервера
    auto_migrate: bool = True

    # Секрет для подписи JWT. Обязателен, задаётся только в .env
    jwt_secret: str = Field(min_length=32)
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 12 * 60

    # Адреса фронтенда через запятую
    cors_origins: str = "http://localhost:5173"

    media_dir: Path = BASE_DIR / "media"

    # Лимиты
    max_body_bytes: int = 1 * 1024 * 1024  # обычные JSON-запросы
    max_audio_bytes: int = 2 * 1024 * 1024  # аудиофайл
    min_frames: int = 10
    max_frames: int = 150
    max_coord: float = 10.0  # нормализованные координаты по модулю

    # Обучение
    min_samples_per_gesture: int = 20

    # Загружать модель таджикского голоса при старте (если установлен requirements-tts.txt)
    tts_warm_up: bool = True

    # Отдавать собранный сайт (frontend/dist) с этого же сервера
    serve_frontend: bool = True

    # Ограничение попыток входа: не больше N за окно в секундах с одного IP
    login_rate_limit: int = 10
    login_rate_window: int = 60

    # Первый администратор (используется скриптом create_admin)
    first_admin_username: str = "admin"
    first_admin_password: str | None = None

    @field_validator("media_dir", mode="before")
    @classmethod
    def _resolve_media(cls, value):
        path = Path(value)
        return path if path.is_absolute() else BASE_DIR / path

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def audio_dir(self) -> Path:
        return self.media_dir / "audio"

    @property
    def models_dir(self) -> Path:
        return self.media_dir / "models"


@lru_cache
def get_settings() -> Settings:
    return Settings()
