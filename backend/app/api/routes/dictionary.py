"""Словарь: жесты, правила фраз, быстрые фразы. Читать может любой, менять — только admin."""

from fastapi import APIRouter, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DB, Admin, OptionalUser, get_or_404
from app.api.serializers import audio_out, model_out
from app.core.errors import AppError
from app.models import AudioClip, Gesture, ModelVersion, Phrase, QuickPhrase, Role
from app.schemas.dictionary import (
    GestureCreate,
    GestureOut,
    GestureUpdate,
    PhraseCreate,
    PhraseOut,
    PhraseUpdate,
    QuickPhraseCreate,
    QuickPhraseOut,
    QuickPhraseUpdate,
)
from app.schemas.models import DictionaryOut
from app.services.audio_storage import delete_media_file

router = APIRouter(tags=["dictionary"])


def _commit_unique(db, code: str):
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise AppError(409, code) from None


def _apply(obj, data):
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(obj, key, value)


# ---------- Жесты ----------


@router.get("/gestures", response_model=list[GestureOut])
def list_gestures(db: DB, user: OptionalUser, category: str | None = None, include_inactive: bool = False):
    """Активные жесты. Администратор может запросить и отключённые."""
    query = select(Gesture).order_by(Gesture.category, Gesture.name_tj)
    if category:
        query = query.where(Gesture.category == category)
    if not (include_inactive and user and user.role == Role.admin):
        query = query.where(Gesture.is_active.is_(True))
    return db.scalars(query).all()


@router.get("/gestures/{gesture_id}", response_model=GestureOut)
def get_gesture(gesture_id: int, db: DB):
    return get_or_404(db, Gesture, gesture_id, "gesture_not_found")


@router.post("/gestures", response_model=GestureOut, status_code=status.HTTP_201_CREATED)
def create_gesture(data: GestureCreate, db: DB, _: Admin):
    gesture = Gesture(**data.model_dump())
    db.add(gesture)
    _commit_unique(db, "gesture_exists")
    db.refresh(gesture)
    return gesture


@router.patch("/gestures/{gesture_id}", response_model=GestureOut)
def update_gesture(gesture_id: int, data: GestureUpdate, db: DB, _: Admin):
    gesture = get_or_404(db, Gesture, gesture_id, "gesture_not_found")
    _apply(gesture, data)
    _commit_unique(db, "gesture_exists")
    db.refresh(gesture)
    return gesture


@router.delete("/gestures/{gesture_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_gesture(gesture_id: int, db: DB, _: Admin):
    """Удаляет жест вместе с его примерами и аудио."""
    gesture = get_or_404(db, Gesture, gesture_id, "gesture_not_found")
    for clip in db.scalars(select(AudioClip).where(AudioClip.gesture_id == gesture_id)):
        delete_media_file(clip.file_path)
    db.delete(gesture)
    db.commit()


# ---------- Правила фраз ----------


@router.get("/phrases", response_model=list[PhraseOut])
def list_phrases(db: DB):
    return db.scalars(select(Phrase).order_by(Phrase.id)).all()


@router.post("/phrases", response_model=PhraseOut, status_code=status.HTTP_201_CREATED)
def create_phrase(data: PhraseCreate, db: DB, _: Admin):
    phrase = Phrase(**data.model_dump())
    db.add(phrase)
    db.commit()
    db.refresh(phrase)
    return phrase


@router.patch("/phrases/{phrase_id}", response_model=PhraseOut)
def update_phrase(phrase_id: int, data: PhraseUpdate, db: DB, _: Admin):
    phrase = get_or_404(db, Phrase, phrase_id, "phrase_not_found")
    _apply(phrase, data)
    db.commit()
    db.refresh(phrase)
    return phrase


@router.delete("/phrases/{phrase_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_phrase(phrase_id: int, db: DB, _: Admin):
    db.delete(get_or_404(db, Phrase, phrase_id, "phrase_not_found"))
    db.commit()


# ---------- Быстрые фразы ----------


@router.get("/quick-phrases", response_model=list[QuickPhraseOut])
def list_quick_phrases(db: DB):
    return db.scalars(select(QuickPhrase).order_by(QuickPhrase.order, QuickPhrase.id)).all()


@router.post("/quick-phrases", response_model=QuickPhraseOut, status_code=status.HTTP_201_CREATED)
def create_quick_phrase(data: QuickPhraseCreate, db: DB, _: Admin):
    phrase = QuickPhrase(**data.model_dump())
    db.add(phrase)
    db.commit()
    db.refresh(phrase)
    return phrase


@router.patch("/quick-phrases/{phrase_id}", response_model=QuickPhraseOut)
def update_quick_phrase(phrase_id: int, data: QuickPhraseUpdate, db: DB, _: Admin):
    phrase = get_or_404(db, QuickPhrase, phrase_id, "phrase_not_found")
    _apply(phrase, data)
    db.commit()
    db.refresh(phrase)
    return phrase


@router.delete("/quick-phrases/{phrase_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_quick_phrase(phrase_id: int, db: DB, _: Admin):
    db.delete(get_or_404(db, QuickPhrase, phrase_id, "phrase_not_found"))
    db.commit()


# ---------- Всё для офлайна ----------


@router.get("/dictionary", response_model=DictionaryOut)
def get_dictionary(request: Request, response: Response, db: DB):
    """Жесты, фразы, быстрые фразы, аудио и опубликованная модель — одним запросом."""
    response.headers["Cache-Control"] = "no-cache"
    published = db.scalar(select(ModelVersion).where(ModelVersion.is_published.is_(True)))
    return DictionaryOut(
        gestures=db.scalars(select(Gesture).where(Gesture.is_active.is_(True)).order_by(Gesture.id)).all(),
        phrases=db.scalars(select(Phrase).order_by(Phrase.id)).all(),
        quick_phrases=db.scalars(select(QuickPhrase).order_by(QuickPhrase.order, QuickPhrase.id)).all(),
        audio=[audio_out(request, c) for c in db.scalars(select(AudioClip).order_by(AudioClip.id))],
        model=model_out(request, published) if published else None,
    )
