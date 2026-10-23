"""Примеры жестов (записи точек рук). Видео сюда не попадает — только числа."""

from fastapi import APIRouter, Query, status
from sqlalchemy import select
from sqlalchemy.orm import defer

from app.api.deps import DB, Admin, Contributor, get_or_404
from app.core.config import FEATURES_PER_FRAME, get_settings
from app.core.errors import AppError
from app.models import Gesture, Role, Sample
from app.schemas.samples import SampleApprove, SampleCreate, SampleDetail, SampleOut

router = APIRouter(prefix="/samples", tags=["samples"])


def _validate_frames(frames: list[list[float]]) -> None:
    settings = get_settings()
    if not settings.min_frames <= len(frames) <= settings.max_frames:
        raise AppError(422, "frames_count", min=settings.min_frames, max=settings.max_frames)
    if any(len(frame) != FEATURES_PER_FRAME for frame in frames):
        raise AppError(422, "frame_size", size=FEATURES_PER_FRAME)


@router.post("", response_model=SampleOut, status_code=status.HTTP_201_CREATED)
def create_sample(data: SampleCreate, db: DB, user: Contributor):
    _validate_frames(data.landmarks)
    get_or_404(db, Gesture, data.gesture_id, "gesture_not_found")
    sample = Sample(
        gesture_id=data.gesture_id,
        user_id=user.id,
        # 4 знака после запятой достаточно и экономит место в БД
        landmarks=[[round(v, 4) for v in frame] for frame in data.landmarks],
        frame_count=len(data.landmarks),
        hand_count=data.hand_count,
        # Примеры администратора сразу одобрены, волонтёров — после проверки
        is_approved=user.role == Role.admin,
    )
    db.add(sample)
    db.commit()
    db.refresh(sample)
    return sample


@router.get("", response_model=list[SampleOut])
def list_samples(
    db: DB,
    user: Contributor,
    gesture_id: int | None = None,
    approved: bool | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """Администратор видит все примеры, волонтёр — только свои."""
    query = select(Sample).options(defer(Sample.landmarks)).order_by(Sample.id.desc())
    if user.role != Role.admin:
        query = query.where(Sample.user_id == user.id)
    if gesture_id is not None:
        query = query.where(Sample.gesture_id == gesture_id)
    if approved is not None:
        query = query.where(Sample.is_approved.is_(approved))
    return db.scalars(query.limit(limit).offset(offset)).all()


@router.get("/{sample_id}", response_model=SampleDetail)
def get_sample(sample_id: int, db: DB, user: Contributor):
    sample = get_or_404(db, Sample, sample_id, "sample_not_found")
    if user.role != Role.admin and sample.user_id != user.id:
        raise AppError(403, "forbidden")
    return sample


@router.patch("/{sample_id}/approve", response_model=SampleOut)
def approve_sample(sample_id: int, db: DB, _: Admin, data: SampleApprove | None = None):
    sample = get_or_404(db, Sample, sample_id, "sample_not_found")
    sample.is_approved = data.is_approved if data else True
    db.commit()
    db.refresh(sample)
    return sample


@router.delete("/{sample_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sample(sample_id: int, db: DB, _: Admin):
    db.delete(get_or_404(db, Sample, sample_id, "sample_not_found"))
    db.commit()
