"""Обучение и публикация модели распознавания."""

from fastapi import APIRouter, Request, status
from sqlalchemy import select

from app.api.deps import DB, Admin, get_or_404
from app.api.serializers import model_out
from app.core.errors import AppError
from app.models import ModelVersion
from app.schemas.models import ModelVersionOut, TrainRequest, TrainStatus
from app.services.training import publish_model, training_manager

router = APIRouter(prefix="/models", tags=["models"])


@router.post("/train", response_model=TrainStatus, status_code=status.HTTP_202_ACCEPTED)
def start_training(db: DB, _: Admin, data: TrainRequest | None = None):
    """Запускает обучение в фоне. Ход обучения — GET /models/train/status."""
    return training_manager.start(db, auto_publish=bool(data and data.auto_publish))


@router.get("/train/status", response_model=TrainStatus)
def training_status(_: Admin):
    return training_manager.status


@router.get("/latest", response_model=ModelVersionOut)
def latest_model(request: Request, db: DB):
    """Опубликованная модель (публично — её скачивает каждый браузер)."""
    model = db.scalar(select(ModelVersion).where(ModelVersion.is_published.is_(True)))
    if not model:
        raise AppError(404, "model_not_found")
    return model_out(request, model)


@router.get("", response_model=list[ModelVersionOut])
def list_models(request: Request, db: DB, _: Admin):
    models = db.scalars(select(ModelVersion).order_by(ModelVersion.version.desc()))
    return [model_out(request, m) for m in models]


@router.post("/{model_id}/publish", response_model=ModelVersionOut)
def publish(model_id: int, request: Request, db: DB, _: Admin, force: bool = False):
    """Публикует модель. Если её точность ниже текущей — ошибка 409 (обойти: ?force=true)."""
    model = get_or_404(db, ModelVersion, model_id, "model_not_found")
    return model_out(request, publish_model(db, model, force=force))
