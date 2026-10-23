from tests.conftest import PASSWORD

API = "/api/v1"


def test_health(client):
    assert client.get(f"{API}/health").json() == {"status": "ok"}


def test_login_and_me(client, admin):
    res = client.get(f"{API}/auth/me", headers=admin)
    assert res.status_code == 200
    assert res.json()["username"] == "admin"
    assert res.json()["role"] == "admin"


def test_login_wrong_password_has_tj_and_ru_message(client, admin):
    res = client.post(f"{API}/auth/login", data={"username": "admin", "password": "wrong-password"})
    assert res.status_code == 401
    body = res.json()
    assert body["code"] == "bad_credentials"
    assert body["message"]["tg"].startswith("Номи корбар")
    assert body["message"]["ru"].startswith("Неверное")


def test_me_requires_token(client):
    res = client.get(f"{API}/auth/me")
    assert res.status_code == 401
    assert res.json()["code"] == "not_authenticated"


def test_me_rejects_forged_token(client):
    res = client.get(f"{API}/auth/me", headers={"Authorization": "Bearer abc.def.ghi"})
    assert res.status_code == 401
    assert res.json()["code"] == "token_invalid"


def test_login_rate_limit(client, admin):
    # В тестах лимит 5 попыток; одна уже потрачена фикстурой admin
    codes = [
        client.post(f"{API}/auth/login", data={"username": "admin", "password": "nope"}).status_code
        for _ in range(5)
    ]
    assert codes[:4] == [401] * 4
    assert codes[4] == 429
    res = client.post(f"{API}/auth/login", data={"username": "admin", "password": PASSWORD})
    assert res.status_code == 429
    assert "Retry-After" in res.headers


def test_admin_manages_users(client, admin, contributor):
    res = client.post(
        f"{API}/users", json={"username": "nigora", "password": "12345678", "role": "contributor"}, headers=admin
    )
    assert res.status_code == 201
    assert client.post(
        f"{API}/users", json={"username": "nigora", "password": "12345678"}, headers=admin
    ).status_code == 409
    # Волонтёр не может управлять пользователями
    assert client.get(f"{API}/users", headers=contributor).status_code == 403
    assert len(client.get(f"{API}/users", headers=admin).json()) == 3


def test_admin_cannot_delete_self(client, admin):
    me = client.get(f"{API}/auth/me", headers=admin).json()
    res = client.delete(f"{API}/users/{me['id']}", headers=admin)
    assert res.status_code == 400
    assert res.json()["code"] == "cannot_delete_self"
