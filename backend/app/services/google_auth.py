"""Вход через Google: проверка «пропуска» (ID token), который выдаёт кнопка Google на сайте.

Подпись проверяет сам Google (адрес tokeninfo) — так не нужны лишние библиотеки.
Запрос к Google асинхронный (httpx): пока Google отвечает, сервер не простаивает.
Мы дополнительно проверяем, что пропуск выдан именно для нашего сайта (aud),
настоящим Google (iss), не просрочен (exp) и почта подтверждена.
"""

import re
import time

import httpx

from app.core.errors import AppError

TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"
ISSUERS = {"accounts.google.com", "https://accounts.google.com"}
TIMEOUT = 10


async def _fetch(credential: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            res = await client.get(TOKENINFO_URL, params={"id_token": credential})
    except httpx.HTTPError as e:
        raise AppError(503, "google_unavailable") from e
    if res.status_code == 400:
        raise AppError(401, "google_bad_token")  # пропуск поддельный или просроченный
    if res.status_code != 200:
        raise AppError(503, "google_unavailable")
    try:
        return res.json()
    except ValueError as e:
        raise AppError(503, "google_unavailable") from e


async def verify(credential: str, client_id: str) -> dict:
    """Проверенные данные аккаунта Google: {sub, email, name}. Иначе — AppError."""
    claims = await _fetch(credential)
    try:
        expired = int(claims.get("exp", 0)) < time.time()
    except (TypeError, ValueError):
        expired = True
    if (
        claims.get("aud") != client_id
        or claims.get("iss") not in ISSUERS
        or expired
        or not claims.get("sub")
        or str(claims.get("email_verified")).lower() != "true"
    ):
        raise AppError(401, "google_bad_token")
    return {
        "sub": str(claims["sub"]),
        "email": claims.get("email"),
        "name": claims.get("given_name") or claims.get("name") or "",
    }


def username_base(name: str) -> str:
    """Имя для сайта из имени в Google: «Муҳаммад Сафаров» → «Муҳаммад». Почту не используем —
    имя видно в таблице лучших."""
    first = name.strip().split()[0] if name.strip() else ""
    clean = re.sub(r"[^\w.\-]", "", first)[:40]
    return clean if len(clean) >= 3 else f"user{clean}"
