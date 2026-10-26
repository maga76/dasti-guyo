"""Вход через Google: проверка «пропуска» (ID token), который выдаёт кнопка Google на сайте.

Подпись проверяет сам Google (адрес tokeninfo) — так не нужны лишние библиотеки.
Мы дополнительно проверяем, что пропуск выдан именно для нашего сайта (aud),
настоящим Google (iss), не просрочен (exp) и почта подтверждена.
"""

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from app.core.errors import AppError

TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"
ISSUERS = {"accounts.google.com", "https://accounts.google.com"}
TIMEOUT = 10


def _fetch(credential: str) -> dict:
    url = f"{TOKENINFO_URL}?{urllib.parse.urlencode({'id_token': credential})}"
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as res:  # noqa: S310 — адрес постоянный, https
            return json.loads(res.read())
    except urllib.error.HTTPError as e:
        # 400 — пропуск поддельный или просроченный
        raise AppError(401, "google_bad_token") from e
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise AppError(503, "google_unavailable") from e


def verify(credential: str, client_id: str) -> dict:
    """Проверенные данные аккаунта Google: {sub, email, name}. Иначе — AppError."""
    claims = _fetch(credential)
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
