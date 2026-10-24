from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select

from app.api.deps import DB, CurrentUser
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.limits import RateLimiter
from app.core.security import create_access_token, hash_password, verify_password
from app.models import Role, User
from app.schemas.users import RegisterIn, Token, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])

_settings = get_settings()
login_limiter = RateLimiter(_settings.login_rate_limit, _settings.login_rate_window)
register_limiter = RateLimiter(_settings.register_rate_limit, _settings.register_rate_window)


@router.post("/register", response_model=Token, status_code=201, summary="Регистрация волонтёра")
def register(request: Request, data: RegisterIn, db: DB):
    """Любой может зарегистрироваться: записывать жесты для обучения ИИ (после проверки
    администратором) и сохранять свои результаты в тренажёре. Роль — всегда «волонтёр»."""
    if not get_settings().allow_registration:
        raise AppError(403, "registration_closed")
    # Защита от массового создания аккаунтов с одного адреса
    register_limiter.hit(request.client.host if request.client else "unknown")
    # Имя без учёта регистра: «Ali» и «ali» — один человек
    if db.scalar(select(User).where(func.lower(User.username) == data.username.lower())):
        raise AppError(409, "user_exists")
    user = User(username=data.username, password_hash=hash_password(data.password), role=Role.contributor)
    db.add(user)
    db.commit()
    db.refresh(user)
    return Token(access_token=create_access_token(user.id, user.role), user=UserOut.model_validate(user))


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
