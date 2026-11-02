"""Чат-бот «Ёрдамчӣ»: отвечает на вопросы посетителей через Google Gemini.

Ключ — бесплатный, с https://aistudio.google.com/apikey, хранится только на сервере (.env:
GEMINI_API_KEY), в браузер не попадает. Запрос асинхронный (httpx): пока Gemini думает,
сервер обслуживает других. Голосовые сообщения бот делает без Gemini — через /tts.
"""

import httpx

from app.core.config import get_settings
from app.core.errors import AppError

URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
TIMEOUT = 40
MAX_REPLY_TOKENS = 1024

SYSTEM = """Ты — «Ёрдамчӣ», ИИ-помощник сайта «Дасти Гӯё» (dastiguyo.king.tj).

О сайте: бесплатный переводчик жестового языка для глухих и слабослышащих в Таджикистане.
Разделы: «Тарҷума» — камера видит жесты и превращает их в текст и голос; «Сӯҳбат» — разговор
глухого и слышащего; «Ба имо» — 3D-аватар показывает жесты по тексту или голосу; «Омӯзиш» —
волонтёры записывают новые жесты; «Талаффуз» — тренажёр произношения с учителем Мадиной;
«Машқ» — тренажёр жестов; «SOS» — экстренные фразы громко и крупно (сайт сам никуда не звонит);
«Дар бораи ИИ» — как устроена нейросеть. Сайт распознаёт 55 слов. Руки находит MediaPipe,
жест определяют две нейросети вместе (MLP и 1D-CNN + Transformer), видео никуда не отправляется.
Честно: жесты взяты из набора Slovo (русский жестовый язык); таджикских жестов в открытом
доступе почти нет — не выдумывай таджикские жесты.

Правила ответа:
- Отвечай на языке вопроса: таджикский (кириллица) или русский.
- Коротко и просто: обычно 1–4 предложения, без сложных терминов.
- Только обычный текст: без Markdown, звёздочек, решёток и таблиц — ответ могут озвучить.
- Можно отвечать и на общие вопросы (учёба, жизнь, наука), вежливо и по делу.
- Если просят «сделай голосом» — сайт делает голосовое сам; просто дай текст.
- Не проси личные данные. При опасности для жизни советуй звонить 112 (скорая — 103).
"""


def enabled() -> bool:
    return bool(get_settings().gemini_api_key)


async def reply(messages: list[tuple[str, str]]) -> str:
    """messages: [(role, text)], role — user | bot, последнее — вопрос человека. Ответ — текст."""
    settings = get_settings()
    if not settings.gemini_api_key:
        raise AppError(503, "chat_disabled")
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [
            {"role": "model" if role == "bot" else "user", "parts": [{"text": text}]} for role, text in messages
        ],
        "generationConfig": {"temperature": 0.6, "maxOutputTokens": MAX_REPLY_TOKENS},
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            res = await client.post(
                URL.format(model=settings.gemini_model),
                json=body,
                headers={"x-goog-api-key": settings.gemini_api_key},
            )
    except httpx.HTTPError as e:
        raise AppError(503, "chat_unavailable") from e
    if res.status_code == 429:
        raise AppError(429, "chat_unavailable")  # кончился бесплатный лимит Google на минуту или день
    if res.status_code != 200:
        raise AppError(503, "chat_unavailable")
    try:
        parts = res.json()["candidates"][0]["content"]["parts"]
        # «Мысли» модели (thought) не показываем — только сам ответ
        text = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise AppError(503, "chat_unavailable") from e
    if not text:
        raise AppError(503, "chat_unavailable")
    return text.replace("**", "").replace("__", "")
