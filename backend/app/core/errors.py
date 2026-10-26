"""Ошибки API с понятными текстами на таджикском и русском.

Формат любой ошибки:
{"code": "gesture_not_found", "message": {"tg": "...", "ru": "..."}, "errors": [...]}
"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

# code -> (таджикский, русский)
MESSAGES: dict[str, tuple[str, str]] = {
    "bad_credentials": ("Номи корбар ё рамз нодуруст аст.", "Неверное имя пользователя или пароль."),
    "not_authenticated": ("Аввал ворид шавед.", "Сначала войдите в систему."),
    "token_invalid": ("Сессия кӯҳна шудааст. Аз нав ворид шавед.", "Сессия устарела. Войдите снова."),
    "forbidden": ("Барои ин амал ҳуқуқ надоред.", "Недостаточно прав для этого действия."),
    "too_many_attempts": (
        "Кӯшишҳо аз ҳад зиёданд. Пас аз {seconds} сония дубора кӯшиш кунед.",
        "Слишком много попыток. Повторите через {seconds} с.",
    ),
    "not_found": ("Ёфт нашуд.", "Не найдено."),
    "gesture_not_found": ("Имо ёфт нашуд.", "Жест не найден."),
    "phrase_not_found": ("Ибора ёфт нашуд.", "Фраза не найдена."),
    "sample_not_found": ("Намуна ёфт нашуд.", "Пример не найден."),
    "audio_not_found": ("Сабти овоз ёфт нашуд.", "Аудиозапись не найдена."),
    "model_not_found": ("Модел ёфт нашуд.", "Модель не найдена."),
    "user_not_found": ("Корбар ёфт нашуд.", "Пользователь не найден."),
    "user_exists": ("Чунин номи корбар аллакай ҳаст.", "Пользователь с таким именем уже есть."),
    "registration_closed": ("Сабти ном ҳоло баста аст.", "Регистрация сейчас закрыта."),
    "google_disabled": ("Воридшавӣ бо Google ҳоло фаъол нест.", "Вход через Google сейчас выключен."),
    "google_bad_token": (
        "Google воридшавиро тасдиқ накард. Боз як бор кӯшиш кунед.",
        "Google не подтвердил вход. Попробуйте ещё раз.",
    ),
    "google_unavailable": (
        "Google ҳоло ҷавоб намедиҳад. Каме дертар кӯшиш кунед.",
        "Google сейчас не отвечает. Попробуйте чуть позже.",
    ),
    "practice_rounds": (
        "Натиҷаи бозӣ нодуруст аст.",
        "Неверный результат игры.",
    ),
    "gesture_exists": ("Имо бо чунин ном аллакай ҳаст.", "Жест с таким названием уже есть."),
    "cannot_delete_self": ("Худатонро нест карда наметавонед.", "Нельзя удалить самого себя."),
    "validation": ("Маълумот нодуруст аст.", "Неверные данные."),
    "body_too_large": ("Дархост хеле калон аст.", "Слишком большой запрос."),
    "audio_too_large": ("Файли овоз аз 2 МБ калон аст.", "Аудиофайл больше 2 МБ."),
    "audio_bad_type": (
        "Навъи файл дастгирӣ намешавад. Танҳо webm, ogg, mp3, mp4, wav.",
        "Тип файла не поддерживается. Только webm, ogg, mp3, mp4, wav.",
    ),
    "audio_empty": ("Файли овоз холӣ аст.", "Аудиофайл пустой."),
    "audio_target": (
        "Сабт бояд ба як имо Ё ба як ибора тааллуқ дошта бошад.",
        "Запись должна относиться либо к жесту, либо к фразе (ровно к одному).",
    ),
    "frame_size": (
        "Ҳар кадр бояд {size} рақам дошта бошад.",
        "Каждый кадр должен содержать {size} чисел.",
    ),
    "frames_count": (
        "Шумораи кадрҳо бояд аз {min} то {max} бошад.",
        "Количество кадров должно быть от {min} до {max}.",
    ),
    "training_running": ("Омӯзиш аллакай идома дорад.", "Обучение уже идёт."),
    "not_enough_samples": (
        "Барои омӯзиш ба ҳар имо камаш {min} намунаи тасдиқшуда лозим аст.",
        "Для обучения нужно минимум {min} одобренных примеров на каждый жест.",
    ),
    "not_enough_gestures": (
        "Барои омӯзиш камаш 2 имо бо намунаҳо лозим аст.",
        "Для обучения нужно минимум 2 жеста с примерами.",
    ),
    "model_worse": (
        "Дақиқии модели нав ({new}) аз модели ҷорӣ ({current}) паст аст.",
        "Точность новой модели ({new}) ниже текущей ({current}).",
    ),
    "tts_unavailable": (
        "Овози тоҷикӣ дар сервер насб нашудааст.",
        "Таджикский голос на сервере не установлен (requirements-tts.txt).",
    ),
    "tts_text": ("Матн барои хондан холӣ аст.", "Нет текста для озвучки."),
    "method_not_allowed": ("Ин амал иҷозат дода намешавад.", "Метод не разрешён."),
    "server_error": ("Хатои сервер. Баъдтар кӯшиш кунед.", "Ошибка сервера. Попробуйте позже."),
}


class AppError(Exception):
    """Ошибка с кодом из MESSAGES. Параметры подставляются в текст."""

    def __init__(self, status: int, code: str, errors: list | None = None, headers=None, **params):
        self.status = status
        self.code = code
        self.params = params
        self.errors = errors
        self.headers = headers
        super().__init__(code)


def error_body(code: str, errors: list | None = None, **params) -> dict:
    tg, ru = MESSAGES.get(code, MESSAGES["server_error"])
    body = {"code": code, "message": {"tg": tg.format(**params), "ru": ru.format(**params)}}
    if errors:
        body["errors"] = errors
    return body


_STATUS_CODES = {401: "not_authenticated", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 413: "body_too_large"}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError):
        return JSONResponse(
            error_body(exc.code, exc.errors, **exc.params), status_code=exc.status, headers=exc.headers
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException):
        code = _STATUS_CODES.get(exc.status_code, "server_error")
        return JSONResponse(error_body(code), status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        # Оставляем только место и текст ошибки — без огромных входных данных
        errors = [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()[:20]]
        return JSONResponse(error_body("validation", errors), status_code=422)
