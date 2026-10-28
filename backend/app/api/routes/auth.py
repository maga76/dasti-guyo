import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, or_, select

from app.api.deps import DB, CurrentUser
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.limits import RateLimiter
from app.core.security import create_access_token, hash_password, verify_password
from app.models import Role, User
from app.schemas.users import AuthOptions, GoogleIn, RegisterIn, Token, UserOut
from app.services import google_auth

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


@router.get("/options", response_model=AuthOptions, summary="Какие способы входа включены")
def options():
    settings = get_settings()
    return AuthOptions(google_client_id=settings.google_client_id or None, allow_registration=settings.allow_registration)


def _free_username(db, base: str) -> str:
    """«Муҳаммад», а если занято — «Муҳаммад2», «Муҳаммад3»…"""
    name, n = base, 1
    while db.scalar(
        select(User.id).where(or_(User.username == name, func.lower(User.username) == name.lower()))
    ):
        n += 1
        name = f"{base}{n}"
    return name


def _google_user(db, account: dict, client_host: str) -> Token:
    """Найти или создать аккаунт по проверенным данным Google (работа с базой и bcrypt — в потоке)."""
    user = db.scalar(select(User).where(User.google_id == account["sub"]))
    if not user:
        if not get_settings().allow_registration:
            raise AppError(403, "registration_closed")
        register_limiter.hit(client_host)
        user = User(
            username=_free_username(db, google_auth.username_base(account["name"])),
            # Пароля у такого аккаунта нет: случайный, никому не известный
            password_hash=hash_password(secrets.token_urlsafe(32)),
            role=Role.contributor,
            google_id=account["sub"],
            email=account["email"],
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    return Token(access_token=create_access_token(user.id, user.role), user=UserOut.model_validate(user))


@router.post("/google", response_model=Token, summary="Вход или регистрация через Google")
async def google(request: Request, data: GoogleIn, db: DB):
    """Кнопка Google на сайте даёт «пропуск» (ID token). Проверяем его у Google асинхронно —
    пока Google отвечает, сервер обслуживает других; если такого человека ещё нет — создаём
    аккаунт волонтёра (как при обычной регистрации)."""
    settings = get_settings()
    if not settings.google_client_id:
        raise AppError(404, "google_disabled")
    client_host = request.client.host if request.client else "unknown"
    login_limiter.hit(client_host)
    account = await google_auth.verify(data.credential, settings.google_client_id)
    return await run_in_threadpool(_google_user, db, account, client_host)


@router.get("/me", response_model=UserOut, summary="Текущий пользователь")
def me(user: CurrentUser):
    return user
