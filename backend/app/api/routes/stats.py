from fastapi import APIRouter
from sqlalchemy import case, func, select

from app.api.deps import DB, Admin
from app.models import AudioClip, Gesture, ModelVersion, Sample, User
from app.schemas.models import GestureStat, StatsOut

router = APIRouter(tags=["stats"])


@router.get("/stats", response_model=StatsOut)
def stats(db: DB, _: Admin):
    users = dict(db.execute(select(User.role, func.count()).group_by(User.role)).all())
    approved_sum = func.coalesce(func.sum(case((Sample.is_approved.is_(True), 1), else_=0)), 0)
    pending_sum = func.coalesce(func.sum(case((Sample.is_approved.is_(False), 1), else_=0)), 0)

    per_gesture = [
        GestureStat(id=g.id, name_tj=g.name_tj, category=g.category, approved=a, pending=p)
        for g, a, p in db.execute(
            select(Gesture, approved_sum, pending_sum)
            .outerjoin(Sample, Sample.gesture_id == Gesture.id)
            .group_by(Gesture.id)
            .order_by(Gesture.id)
        )
    ]
    published = db.scalar(select(ModelVersion).where(ModelVersion.is_published.is_(True)))
    approved = sum(g.approved for g in per_gesture)
    pending = sum(g.pending for g in per_gesture)

    return StatsOut(
        users=users,
        gestures=len(per_gesture),
        samples_total=approved + pending,
        samples_approved=approved,
        samples_pending=pending,
        audio_clips=db.scalar(select(func.count(AudioClip.id))),
        model_versions=db.scalar(select(func.count(ModelVersion.id))),
        published_version=published.version if published else None,
        published_accuracy=published.accuracy if published else None,
        per_gesture=per_gesture,
    )
