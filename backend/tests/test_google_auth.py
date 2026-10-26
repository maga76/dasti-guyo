"""Вход через Google. Сам Google в тестах не вызывается — ответ tokeninfo подменяется."""

import time

import pytest

from app.core.config import get_settings
from app.core.errors import AppError
from app.services import google_auth

API = "/api/v1"
CLIENT_ID = "test-client.apps.googleusercontent.com"
TOKEN = "x" * 40


def claims(**over):
    base = {
        "aud": CLIENT_ID,
        "iss": "https://accounts.google.com",
        "exp": str(int(time.time()) + 600),
        "sub": "1234567890",
        "email": "ali@example.com",
        "email_verified": "true",
        "given_name": "Алӣ",
        "name": "Алӣ Валиев",
    }
    base.update(over)
    return base


@pytest.fixture
def google_on(monkeypatch):
    monkeypatch.setattr(get_settings(), "google_client_id", CLIENT_ID)
    answer = {"claims": claims()}
    monkeypatch.setattr(google_auth, "_fetch", lambda credential: answer["claims"])
    return answer


def test_options_without_google(client):
    res = client.get(f"{API}/auth/options")
    assert res.status_code == 200
    assert res.json()["google_client_id"] is None


def test_google_disabled(client):
    assert client.post(f"{API}/auth/google", json={"credential": TOKEN}).status_code == 404


def test_google_creates_account_once(client, google_on):
    assert client.get(f"{API}/auth/options").json()["google_client_id"] == CLIENT_ID
    first = client.post(f"{API}/auth/google", json={"credential": TOKEN})
    assert first.status_code == 200
    user = first.json()["user"]
    assert user["username"] == "Алӣ"  # имя из Google, а не почта
    assert user["role"] == "contributor"
    # Второй вход — тот же аккаунт
    second = client.post(f"{API}/auth/google", json={"credential": TOKEN})
    assert second.json()["user"]["id"] == user["id"]
    token = second.json()["access_token"]
    assert client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 200


def test_google_name_taken_gets_number(client, google_on, contributor):
    google_on["claims"] = claims(given_name="volunteer", sub="555")
    res = client.post(f"{API}/auth/google", json={"credential": TOKEN})
    assert res.json()["user"]["username"] == "volunteer2"


@pytest.mark.parametrize(
    "bad",
    [
        {"aud": "someone-else"},
        {"iss": "evil.example.com"},
        {"exp": "1"},
        {"email_verified": "false"},
    ],
)
def test_google_rejects_bad_token(client, google_on, bad):
    google_on["claims"] = claims(**bad)
    res = client.post(f"{API}/auth/google", json={"credential": TOKEN})
    assert res.status_code == 401
    assert res.json()["code"] == "google_bad_token"


def test_username_base():
    assert google_auth.username_base("Муҳаммад Сафаров") == "Муҳаммад"
    assert google_auth.username_base("") == "user"
    assert google_auth.username_base("Al") == "userAl"


def test_google_unreachable(monkeypatch):
    def offline(url, timeout):
        raise TimeoutError()

    monkeypatch.setattr(google_auth.urllib.request, "urlopen", offline)
    with pytest.raises(AppError) as err:
        google_auth.verify(TOKEN, CLIENT_ID)
    assert err.value.status == 503
