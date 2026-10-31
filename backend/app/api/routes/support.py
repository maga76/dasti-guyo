"""Поддержка: любой посетитель пишет о проблеме или идее, администратор читает и отмечает разобранные."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from app.api.deps import DB, Admin, OptionalUser, get_or_404
from app.core.limits import RateLimiter
from app.models import SupportMessage, User
from app.models.support import SupportKind, SupportStatus

router = APIRouter(prefix="/support", tags=["support"])

# Не больше 5 сообщений за 10 минут с одного адреса — от спама
support_limiter = RateLimiter(5, 600)


class SupportIn(BaseModel):
    kind: SupportKind = SupportKind.problem
    message: str = Field(min_length=3, max_length=2000)
    contact: str | None = Field(default=None, max_length=120)
    page: str | None = Field(default=None, max_length=40)


class SupportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: SupportKind
    message: str
    contact: str | None
    page: str | None
    user_agent: str | None
    status: SupportStatus
    created_at: datetime
    username: str | None = None


class SupportList(BaseModel):
    items: list[SupportOut]
    new: int


class SupportUpdate(BaseModel):
    status: SupportStatus


@router.post("", response_model=SupportOut, status_code=status.HTTP_201_CREATED, summary="Написать в поддержку")
def create(request: Request, data: SupportIn, db: DB, user: OptionalUser):
    support_limiter.hit(request.client.host if request.client else "unknown")
    item = SupportMessage(
        user_id=user.id if user else None,
        kind=data.kind,
        message=data.message.strip(),
        contact=(data.contact or "").strip() or None,
        page=data.page,
        user_agent=(request.headers.get("user-agent") or "")[:300] or None,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return SupportOut.model_validate(item).model_copy(update={"username": user.username if user else None})


@router.get("", response_model=SupportList, summary="Сообщения в поддержку (администратор)")
def list_messages(
    db: DB, _: Admin, only_new: Annotated[bool, Query()] = False, limit: Annotated[int, Query(le=500)] = 200
):
    query = (
        select(SupportMessage, User.username)
        .outerjoin(User, User.id == SupportMessage.user_id)
        .order_by(SupportMessage.id.desc())
        .limit(limit)
    )
    if only_new:
        query = query.where(SupportMessage.status == SupportStatus.new)
    items = [
        SupportOut.model_validate(message).model_copy(update={"username": username})
        for message, username in db.execute(query)
    ]
    new = db.scalar(select(func.count()).where(SupportMessage.status == SupportStatus.new)) or 0
    return SupportList(items=items, new=new)


@router.patch("/{message_id}", response_model=SupportOut, summary="Отметить разобранным / новым (администратор)")
def update(message_id: int, data: SupportUpdate, db: DB, _: Admin):
    item = get_or_404(db, SupportMessage, message_id, "not_found")
    item.status = data.status
    db.commit()
    db.refresh(item)
    return item
