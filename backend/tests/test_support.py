"""Поддержка: писать может любой, читать и разбирать — только администратор."""

API = "/api/v1"


def test_guest_writes_admin_reads_and_marks_done(client, admin):
    res = client.post(
        f"{API}/support",
        json={"kind": "problem", "message": "Камера не включается на телефоне", "contact": "@ali", "page": "translate"},
        headers={"User-Agent": "TestPhone/1.0"},
    )
    assert res.status_code == 201, res.text
    item = res.json()
    assert item["status"] == "new" and item["username"] is None and item["user_agent"] == "TestPhone/1.0"

    listed = client.get(f"{API}/support", headers=admin).json()
    assert listed["new"] == 1 and listed["items"][0]["message"].startswith("Камера")

    done = client.patch(f"{API}/support/{item['id']}", json={"status": "done"}, headers=admin)
    assert done.json()["status"] == "done"
    assert client.get(f"{API}/support", headers=admin).json()["new"] == 0
    assert client.get(f"{API}/support?only_new=true", headers=admin).json()["items"] == []


def test_logged_in_user_is_linked(client, contributor):
    res = client.post(f"{API}/support", json={"kind": "idea", "message": "Добавьте слово «футбол»"}, headers=contributor)
    assert res.status_code == 201
    assert res.json()["username"] == "volunteer"


def test_only_admin_reads(client, contributor):
    assert client.get(f"{API}/support").status_code == 401
    assert client.get(f"{API}/support", headers=contributor).status_code == 403


def test_validation_and_rate_limit(client):
    assert client.post(f"{API}/support", json={"message": "ок"}).status_code == 422  # слишком коротко
    assert client.post(f"{API}/support", json={"kind": "spam", "message": "привет всем"}).status_code == 422
    codes = [client.post(f"{API}/support", json={"message": f"сообщение {i}"}).status_code for i in range(6)]
    assert codes[:5] == [201] * 5 and codes[5] == 429
