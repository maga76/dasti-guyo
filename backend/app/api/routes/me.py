"""Личный кабинет: профиль, результаты тренажёра, таблица лучших."""

from fastapi import APIRouter, status
from sqlalchemy import func, select

from app.api.deps import DB, CurrentUser
from app.models import PracticeResult, Sample, User
from app.schemas.profile import LeaderboardOut, LeaderRow, PracticeIn, PracticeOut, ProfileOut
from app.services.profile import profile

router = APIRouter(tags=["profile"])

LEADERBOARD_SIZE = 10


@router.get("/me/profile", response_model=ProfileOut, summary="Мой вклад в ИИ и моё знание жестов")
def my_profile(db: DB, user: CurrentUser):
    return profile(db, user)


@router.post(
    "/me/practice",
    response_model=PracticeOut,
    status_code=status.HTTP_201_CREATED,
    summary="Сохранить итог игры в тренажёре",
)
def save_practice(data: PracticeIn, db: DB, user: CurrentUser):
    correct = sum(r.ok for r in data.rounds)
    result = PracticeResult(
        user_id=user.id,
        # Баллы не могут быть больше, чем дают правильные ответы с наибольшим бонусом за серию
        score=min(data.score, correct * 20),
        correct=correct,
        total=len(data.rounds),
        rounds=[r.model_dump() for r in data.rounds],
    )
    db.add(result)
    db.commit()
    db.refresh(result)
    return result


@router.get("/leaderboard", response_model=LeaderboardOut, summary="Лучшие помощники ИИ и игроки (только имена)")
def leaderboard(db: DB):
    contributors = db.execute(
        select(User.username, func.count(Sample.id).label("n"))
        .join(Sample, Sample.user_id == User.id)
        .where(Sample.is_approved.is_(True))
        .group_by(User.id)
        .order_by(func.count(Sample.id).desc(), User.username)
        .limit(LEADERBOARD_SIZE)
    ).all()
    players = db.execute(
        select(User.username, func.max(PracticeResult.score).label("best"))
        .join(PracticeResult, PracticeResult.user_id == User.id)
        .group_by(User.id)
        .order_by(func.max(PracticeResult.score).desc(), User.username)
        .limit(LEADERBOARD_SIZE)
    ).all()
    return LeaderboardOut(
        contributors=[LeaderRow(username=u, value=n) for u, n in contributors],
        players=[LeaderRow(username=u, value=b) for u, b in players if b > 0],
    )
