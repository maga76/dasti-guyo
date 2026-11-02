"""Чат-бот «Ёрдамчӣ»: без ключа — понятная ошибка; с ключом — вопрос уходит в Gemini, ответ приходит текстом."""

import httpx

from app.core.config import get_settings
from app.services import chatbot

API = "/api/v1"


def test_without_key_bot_is_off(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "gemini_api_key", "")
    assert client.get(f"{API}/chat/status").json() == {"enabled": False}
    res = client.post(f"{API}/chat", json={"messages": [{"role": "user", "text": "Салом"}]})
    assert res.status_code == 503 and res.json()["code"] == "chat_disabled"


def test_question_goes_to_gemini(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "gemini_api_key", "test-key")
    sent = {}

    def handler(request: httpx.Request):
        sent["key"] = request.headers["x-goog-api-key"]
        sent["body"] = request.read().decode()
        answer = {"candidates": [{"content": {"parts": [{"text": "думаю…", "thought": True}, {"text": "**Салом!** Ман хубам."}]}}]}
        return httpx.Response(200, json=answer)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(chatbot.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    assert client.get(f"{API}/chat/status").json() == {"enabled": True}
    res = client.post(
        f"{API}/chat",
        json={"messages": [{"role": "user", "text": "Салом"}, {"role": "bot", "text": "Салом!"}, {"role": "user", "text": "Чӣ хел?"}]},
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"reply": "Салом! Ман хубам."}  # без «мыслей» и без звёздочек
    assert sent["key"] == "test-key" and '"role": "model"' in sent["body"].replace('":"', '": "')


def test_gemini_down_and_validation(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "gemini_api_key", "test-key")
    real_client = httpx.AsyncClient
    down = httpx.MockTransport(lambda request: httpx.Response(500))
    monkeypatch.setattr(chatbot.httpx, "AsyncClient", lambda **kw: real_client(transport=down, **kw))
    res = client.post(f"{API}/chat", json={"messages": [{"role": "user", "text": "Салом"}]})
    assert res.status_code == 503 and res.json()["code"] == "chat_unavailable"
    assert client.post(f"{API}/chat", json={"messages": []}).status_code == 422
    assert client.post(f"{API}/chat", json={"messages": [{"role": "admin", "text": "x"}]}).status_code == 422
