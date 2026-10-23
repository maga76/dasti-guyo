"""Общие зависимости эндпоинтов: БД и проверка ролей."""

from typing import Annotated

import jwt
from fastapi import Depends
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import AppError
from app.core.security import decode_access_token
from app.models import Role, User

# auto_error=False — чтобы вернуть свою ошибку на таджикском/русском
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)

DB = Annotated[Session, Depends(get_db)]

_AUTH_HEADERS = {"WWW-Authenticate": "Bearer"}


def get_optional_user(db: DB, token: Annotated[str | None, Depends(oauth2_scheme)]) -> User | None:
    """Пользователь, если передан токен. Без токена — None (обычный посетитель)."""
    if not token:
        return None
    try:
        payload = decode_access_token(token)
        user = db.get(User, int(payload["sub"]))
    except (jwt.PyJWTError, KeyError, ValueError):
        raise AppError(401, "token_invalid", headers=_AUTH_HEADERS) from None
    if not user:
        raise AppError(401, "token_invalid", headers=_AUTH_HEADERS)
    return user


def get_current_user(user: Annotated[User | None, Depends(get_optional_user)]) -> User:
    if not user:
        raise AppError(401, "not_authenticated", headers=_AUTH_HEADERS)
    return user


def require_contributor(user: Annotated[User, Depends(get_current_user)]) -> User:
    """Волонтёр или администратор."""
    if user.role not in (Role.contributor, Role.admin):
        raise AppError(403, "forbidden")
    return user


def require_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != Role.admin:
        raise AppError(403, "forbidden")
    return user


OptionalUser = Annotated[User | None, Depends(get_optional_user)]
CurrentUser = Annotated[User, Depends(get_current_user)]
Contributor = Annotated[User, Depends(require_contributor)]
Admin = Annotated[User, Depends(require_admin)]


def get_or_404(db: Session, model, obj_id: int, code: str):
    obj = db.get(model, obj_id)
    if obj is None:
        raise AppError(404, code)
    return obj
