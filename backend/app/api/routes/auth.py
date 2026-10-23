from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select

from app.api.deps import DB, CurrentUser
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.limits import RateLimiter
from app.core.security import create_access_token, verify_password
from app.models import User
from app.schemas.users import Token, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])

_settings = get_settings()
login_limiter = RateLimiter(_settings.login_rate_limit, _settings.login_rate_window)


@router.post("/login", response_model=Token, summary="Вход (form: username, password)")
def login(request: Request, db: DB, form: Annotated[OAuth2PasswordRequestForm, Depends()]):
    # Защита от перебора паролей: ограничиваем попытки с одного адреса
    login_limiter.hit(request.client.host if request.client else "unknown")

    user = db.scalar(select(User).where(User.username == form.username))
    if not user or not verify_password(form.password, user.password_hash):
        raise AppError(401, "bad_credentials")
    return Token(access_token=create_access_token(user.id, user.role), user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut, summary="Текущий пользователь")
def me(user: CurrentUser):
    return user
