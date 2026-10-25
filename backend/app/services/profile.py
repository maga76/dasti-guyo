"""Профиль: вклад человека в обучение нашей нейросети и его знание жестов.

Баллы — за всё сразу, чтобы было интересно и учить язык, и помогать ИИ:
  одобренная запись жеста — 10, запись на проверке — 2,
  правильно показанный жест в тренажёре — 3, выученный жест — 20,
  правильно произнесённое слово в «Талаффуз» — 2, освоенное слово — 10.
"""

from collections import defaultdict

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models import Gesture, ModelVersion, PracticeResult, Sample, SpeechResult, User
from app.schemas.profile import (
    Contribution,
    GestureContribution,
    Knowledge,
    PracticeOut,
    ProfileOut,
    Speech,
    SpeechAttempt,
    SpeechWord,
    WordSkill,
)
from app.schemas.users import UserOut

POINTS_APPROVED = 10
POINTS_PENDING = 2
POINTS_CORRECT_ROUND = 3
POINTS_KNOWN_WORD = 20
POINTS_SPEECH_CORRECT = 2
POINTS_SPEECH_MASTERED = 10

# Произношение: попытка засчитана, если похожесть ≥ SPEECH_PASS (как на сайте, speech-words.json → pass).
# Слово освоено: не меньше 2 удачных попыток и последняя — удачная
SPEECH_PASS = 0.75
SPEECH_MASTERED_OK = 2
SPEECH_HISTORY = 30

# Уровень → с какого количества баллов (по возрастанию)
LEVELS = [("novice", 0), ("learner", 100), ("helper", 300), ("expert", 700), ("master", 1500)]

# Насколько знает жест — по последним попыткам: старые ошибки не должны тянуть вниз вечно
RECENT_ATTEMPTS = 5
KNOWN_MASTERY = 0.6
KNOWN_MIN_ATTEMPTS = 2
HISTORY_GAMES = 20


def level_for(points: int) -> tuple[str, int | None]:
    """Уровень и сколько баллов нужно до следующего (None — максимальный)."""
    current, next_points = LEVELS[0][0], None
    for i, (name, need) in enumerate(LEVELS):
        if points >= need:
            current = name
            next_points = LEVELS[i + 1][1] if i + 1 < len(LEVELS) else None
    return current, next_points


def contribution(db: Session, user: User) -> Contribution:
    approved_sum = func.coalesce(func.sum(case((Sample.is_approved.is_(True), 1), else_=0)), 0)
    pending_sum = func.coalesce(func.sum(case((Sample.is_approved.is_(False), 1), else_=0)), 0)
    rows = db.execute(
        select(Gesture, approved_sum, pending_sum)
        .join(Sample, Sample.gesture_id == Gesture.id)
        .where(Sample.user_id == user.id)
        .group_by(Gesture.id)
        .order_by(Gesture.name_tj)
    ).all()
    gestures = [
        GestureContribution(gesture_id=g.id, name_tj=g.name_tj, name_ru=g.name_ru, approved=a, pending=p)
        for g, a, p in rows
    ]
    approved = sum(g.approved for g in gestures)
    pending = sum(g.pending for g in gestures)

    published = db.scalar(select(ModelVersion).where(ModelVersion.is_published.is_(True)))
    in_model = 0
    if published:
        in_model = db.scalar(
            select(func.count(Sample.id)).where(
                Sample.user_id == user.id,
                Sample.is_approved.is_(True),
                Sample.created_at <= published.created_at,
            )
        )
    return Contribution(
        total=approved + pending,
        approved=approved,
        pending=pending,
        in_model=in_model,
        model_version=published.version if published else None,
        gestures=gestures,
    )


def knowledge(db: Session, user: User) -> Knowledge:
    games = db.scalars(
        select(PracticeResult).where(PracticeResult.user_id == user.id).order_by(PracticeResult.created_at)
    ).all()
    # Все попытки по каждому жесту — по порядку игр
    attempts: dict[str, list[bool]] = defaultdict(list)
    for game in games:
        for r in game.rounds:
            attempts[r["label"]].append(bool(r["ok"]))

    words = []
    for label, results in attempts.items():
        recent = results[-RECENT_ATTEMPTS:]
        words.append(
            WordSkill(
                label=label,
                attempts=len(results),
                correct=sum(results),
                mastery=round(sum(recent) / len(recent), 3),
            )
        )
    words.sort(key=lambda w: (-w.mastery, -w.attempts, w.label))
    known = sum(1 for w in words if w.mastery >= KNOWN_MASTERY and w.attempts >= KNOWN_MIN_ATTEMPTS)

    return Knowledge(
        games=len(games),
        best_score=max((g.score for g in games), default=0),
        rounds=sum(g.total for g in games),
        correct=sum(g.correct for g in games),
        known_words=known,
        words=words,
        history=[PracticeOut.model_validate(g) for g in games[-HISTORY_GAMES:]],
    )


def speech(db: Session, user: User) -> Speech:
    attempts = db.scalars(
        select(SpeechResult).where(SpeechResult.user_id == user.id).order_by(SpeechResult.created_at, SpeechResult.id)
    ).all()
    # По словам без учёта регистра; показываем написание последней попытки
    groups: dict[str, list[SpeechResult]] = defaultdict(list)
    for a in attempts:
        groups[a.word.strip().lower()].append(a)
    words = []
    for items in groups.values():
        oks = [a.score >= SPEECH_PASS for a in items]
        words.append(
            SpeechWord(
                word=items[-1].word,
                attempts=len(items),
                correct=sum(oks),
                best=round(max(a.score for a in items), 3),
                last=round(items[-1].score, 3),
                mastered=sum(oks) >= SPEECH_MASTERED_OK and oks[-1],
            )
        )
    words.sort(key=lambda w: (not w.mastered, -w.best, w.word))
    return Speech(
        attempts=len(attempts),
        correct=sum(a.score >= SPEECH_PASS for a in attempts),
        mastered_words=sum(w.mastered for w in words),
        words=words,
        history=[
            SpeechAttempt(word=a.word, score=round(a.score, 3), ok=a.score >= SPEECH_PASS, created_at=a.created_at)
            for a in attempts[-SPEECH_HISTORY:]
        ],
    )


def profile(db: Session, user: User) -> ProfileOut:
    contrib = contribution(db, user)
    know = knowledge(db, user)
    talk = speech(db, user)
    points = (
        contrib.approved * POINTS_APPROVED
        + contrib.pending * POINTS_PENDING
        + know.correct * POINTS_CORRECT_ROUND
        + know.known_words * POINTS_KNOWN_WORD
        + talk.correct * POINTS_SPEECH_CORRECT
        + talk.mastered_words * POINTS_SPEECH_MASTERED
    )
    level, next_points = level_for(points)
    return ProfileOut(
        user=UserOut.model_validate(user),
        points=points,
        level=level,
        next_level_points=next_points,
        contribution=contrib,
        knowledge=know,
        speech=talk,
    )
