"""Регистрация, профиль (вклад в ИИ и знание жестов), тренажёр, таблица лучших."""

from datetime import timedelta

from sqlalchemy import update

from app.core.database import SessionLocal
from app.models import ModelVersion, Sample
from app.models.user import utcnow
from tests.conftest import make_frames

API = "/api/v1"


def register(client, username="ali", password="secret-pass-1"):
    return client.post(f"{API}/auth/register", json={"username": username, "password": password})


def auth(res) -> dict:
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def test_register_creates_volunteer_and_logs_in(client):
    res = register(client)
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["user"]["username"] == "ali"
    assert body["user"]["role"] == "contributor"
    # Токен сразу рабочий
    me = client.get(f"{API}/auth/me", headers=auth(res))
    assert me.json()["username"] == "ali"
    # И войти по паролю тоже можно
    login = client.post(f"{API}/auth/login", data={"username": "ali", "password": "secret-pass-1"})
    assert login.status_code == 200


def test_register_rejects_taken_name_any_case(client):
    assert register(client, "Ali").status_code == 201
    res = register(client, "ali")
    assert res.status_code == 409
    assert res.json()["code"] == "user_exists"


def test_register_cannot_choose_role(client):
    res = client.post(f"{API}/auth/register", json={"username": "hacker", "password": "secret-pass-1", "role": "admin"})
    assert res.status_code == 201
    assert res.json()["user"]["role"] == "contributor"


def test_register_validates_input(client):
    assert register(client, "ab").status_code == 422  # короткое имя
    assert register(client, "has space").status_code == 422
    assert register(client, "valid_name", "short").status_code == 422  # короткий пароль


def test_register_rate_limited(client):
    for i in range(5):
        assert register(client, f"user{i}").status_code == 201
    res = register(client, "user5")
    assert res.status_code == 429
    assert "Retry-After" in res.headers


def test_profile_requires_login(client):
    assert client.get(f"{API}/me/profile").status_code == 401


def test_profile_empty_for_new_user(client):
    headers = auth(register(client))
    data = client.get(f"{API}/me/profile", headers=headers).json()
    assert data["points"] == 0
    assert data["level"] == "novice"
    assert data["next_level_points"] == 100
    assert data["contribution"]["total"] == 0
    assert data["knowledge"]["games"] == 0
    assert data["knowledge"]["words"] == []


def test_profile_counts_contribution(client, gesture, admin):
    headers = auth(register(client))
    ids = []
    for seed in range(3):
        res = client.post(
            f"{API}/samples",
            json={"gesture_id": gesture["id"], "landmarks": make_frames(seed=seed), "hand_count": 1},
            headers=headers,
        )
        assert res.status_code == 201
        ids.append(res.json()["id"])
    # Администратор одобрил две записи
    for sample_id in ids[:2]:
        client.patch(f"{API}/samples/{sample_id}/approve", headers=admin)

    data = client.get(f"{API}/me/profile", headers=headers).json()
    contrib = data["contribution"]
    assert (contrib["total"], contrib["approved"], contrib["pending"]) == (3, 2, 1)
    assert contrib["gestures"][0]["name_tj"] == "Салом"
    assert contrib["model_version"] is None and contrib["in_model"] == 0
    assert data["points"] == 2 * 10 + 1 * 2

    # Опубликована модель, обученная после первой записи: в ней только записи, сделанные до неё
    with SessionLocal() as db:
        db.execute(update(Sample).where(Sample.id == ids[1]).values(created_at=utcnow() + timedelta(hours=1)))
        db.add(ModelVersion(version=1, accuracy=0.9, gesture_list=[], file_path="models/v1", is_published=True))
        db.commit()
    contrib = client.get(f"{API}/me/profile", headers=headers).json()["contribution"]
    assert contrib["model_version"] == 1
    assert contrib["in_model"] == 1


def test_practice_results_build_knowledge(client):
    headers = auth(register(client))
    games = [
        [("Салом", True), ("Об", False), ("Хуб", True)],
        [("Салом", True), ("Об", True), ("Хуб", True)],
    ]
    for rounds in games:
        res = client.post(
            f"{API}/me/practice",
            json={"score": 30, "rounds": [{"label": label, "ok": ok} for label, ok in rounds]},
            headers=headers,
        )
        assert res.status_code == 201, res.text

    data = client.get(f"{API}/me/profile", headers=headers).json()
    know = data["knowledge"]
    assert know["games"] == 2
    assert know["rounds"] == 6 and know["correct"] == 5
    words = {w["label"]: w for w in know["words"]}
    assert words["Салом"]["mastery"] == 1.0
    assert words["Об"]["mastery"] == 0.5
    # «Знает»: доля правильных ≥ 60% хотя бы по двум попыткам — Салом и Хуб
    assert know["known_words"] == 2
    assert len(know["history"]) == 2
    assert data["points"] == 5 * 3 + 2 * 20


def test_practice_score_cannot_be_inflated(client):
    headers = auth(register(client))
    res = client.post(
        f"{API}/me/practice", json={"score": 9999, "rounds": [{"label": "Салом", "ok": True}]}, headers=headers
    )
    assert res.json()["score"] == 20  # одна правильная попытка — не больше 20 баллов


def test_practice_requires_login(client):
    res = client.post(f"{API}/me/practice", json={"score": 10, "rounds": [{"label": "Салом", "ok": True}]})
    assert res.status_code == 401


def test_leaderboard_shows_only_names(client, gesture, admin):
    a = auth(register(client, "ali"))
    b = auth(register(client, "zarina"))
    client.post(f"{API}/me/practice", json={"score": 40, "rounds": [{"label": "Салом", "ok": True}] * 2}, headers=a)
    client.post(f"{API}/me/practice", json={"score": 60, "rounds": [{"label": "Салом", "ok": True}] * 3}, headers=b)
    res = client.post(
        f"{API}/samples", json={"gesture_id": gesture["id"], "landmarks": make_frames(), "hand_count": 1}, headers=a
    )
    client.patch(f"{API}/samples/{res.json()['id']}/approve", headers=admin)

    data = client.get(f"{API}/leaderboard").json()
    assert data["players"] == [{"username": "zarina", "value": 60}, {"username": "ali", "value": 40}]
    assert data["contributors"] == [{"username": "ali", "value": 1}]
