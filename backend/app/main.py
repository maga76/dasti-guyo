"""Точка входа: uvicorn app.main:app --reload"""

import logging
import threading
from contextlib import asynccontextmanager

import anyio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.router import api_router
from app.core.config import BASE_DIR, get_settings
from app.core.errors import register_error_handlers
from app.core.limits import BodySizeLimitMiddleware
from app.services import tts

API_PREFIX = "/api/v1"
THREADS = 100  # потоков для обычных запросов (см. lifespan)
settings = get_settings()
logging.basicConfig(level=logging.INFO)
logging.getLogger("alembic.runtime.plugins").setLevel(logging.WARNING)


def run_migrations() -> None:
    """Применяет миграции Alembic при старте — не нужно помнить про `alembic upgrade head`."""
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(BASE_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BASE_DIR / "alembic"))
    cfg.attributes["skip_logging_config"] = True
    command.upgrade(cfg, "head")


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Обычные (не async) запросы FastAPI выполняет параллельно в пуле потоков; по умолчанию их 40.
    # Больше потоков — больше людей обслуживается одновременно (запросы к SQLite короткие)
    anyio.to_thread.current_default_thread_limiter().total_tokens = THREADS
    settings.audio_dir.mkdir(parents=True, exist_ok=True)
    settings.models_dir.mkdir(parents=True, exist_ok=True)
    if settings.auto_migrate:
        run_migrations()
    if settings.tts_warm_up:
        # Модель голоса грузится ~30 с — делаем это в фоне, сервер отвечает сразу
        threading.Thread(target=tts.warm_up, daemon=True, name="tts-warm-up").start()
    yield


app = FastAPI(
    title=settings.app_name,
    description="API переводчика таджикского жестового языка. Видео на сервер не отправляется — только точки рук.",
    version="0.4.0",
    lifespan=lifespan,
)

# CORS — только для адреса(ов) фронтенда из .env
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
app.add_middleware(
    BodySizeLimitMiddleware,
    default_limit=settings.max_body_bytes,
    # аудио до 2 МБ + запас на поля формы
    audio_limit=settings.max_audio_bytes + 64 * 1024,
    audio_path=f"{API_PREFIX}/audio",
)
register_error_handlers(app)
app.include_router(api_router, prefix=API_PREFIX)

# Файлы моделей TF.js (model.json + weights.bin) раздаются как статика
settings.models_dir.mkdir(parents=True, exist_ok=True)
app.mount("/media/models", StaticFiles(directory=settings.models_dir), name="models")

# Если сайт собран (npm run build), сервер отдаёт и его — для выкладки хватает одного сервера
FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"
if settings.serve_frontend and (FRONTEND_DIST / "index.html").exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
