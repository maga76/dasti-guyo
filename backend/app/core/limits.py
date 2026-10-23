"""Защита от злоупотреблений: лимит размера запроса и частоты попыток входа."""

import time
from collections import defaultdict, deque
from threading import Lock

from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.errors import AppError


class BodySizeLimitMiddleware:
    """Отклоняет слишком большие запросы (413), не дочитывая их целиком.

    Для загрузки аудио лимит больше: файл до 2 МБ + служебные данные формы.
    """

    def __init__(self, app: ASGIApp, default_limit: int, audio_limit: int, audio_path: str):
        self.app = app
        self.default_limit = default_limit
        self.audio_limit = audio_limit
        self.audio_path = audio_path

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            return await self.app(scope, receive, send)

        limit = self.audio_limit if scope["path"].startswith(self.audio_path) else self.default_limit

        # Быстрая проверка по заголовку Content-Length
        for name, value in scope.get("headers", []):
            if name == b"content-length" and value.isdigit() and int(value) > limit:
                return await _send_413(scope, receive, send)

        # Подстраховка для запросов без Content-Length: считаем байты на лету
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise AppError(413, "body_too_large")
            return message

        await self.app(scope, limited_receive, send)


async def _send_413(scope, receive, send):
    from fastapi.responses import JSONResponse

    from app.core.errors import error_body

    response = JSONResponse(error_body("body_too_large"), status_code=413)
    await response(scope, receive, send)


class RateLimiter:
    """Скользящее окно в памяти процесса: не больше `limit` событий за `window` секунд.

    Для одного сервера этого достаточно. При нескольких процессах нужен Redis.
    """

    def __init__(self, limit: int, window: int):
        self.limit = limit
        self.window = window
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def hit(self, key: str) -> None:
        """Регистрирует попытку. Бросает AppError(429), если лимит превышен."""
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                retry = int(self.window - (now - hits[0])) + 1
                raise AppError(429, "too_many_attempts", headers={"Retry-After": str(retry)}, seconds=retry)
            hits.append(now)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
