API = "/api/v1"


def test_gesture_write_requires_admin(client, contributor):
    data = {"name_tj": "Об", "name_ru": "Вода"}
    assert client.post(f"{API}/gestures", json=data).status_code == 401
    res = client.post(f"{API}/gestures", json=data, headers=contributor)
    assert res.status_code == 403
    assert res.json()["code"] == "forbidden"


def test_gesture_crud(client, admin):
    res = client.post(f"{API}/gestures", json={"name_tj": "Об", "name_ru": "Вода"}, headers=admin)
    assert res.status_code == 201
    gid = res.json()["id"]

    # Дубликат названия
    dup = client.post(f"{API}/gestures", json={"name_tj": "Об"}, headers=admin)
    assert dup.status_code == 409
    assert dup.json()["code"] == "gesture_exists"

    # Публичный список
    assert [g["name_tj"] for g in client.get(f"{API}/gestures").json()] == ["Об"]

    # Отключённый жест скрыт от посетителей, но виден админу
    client.patch(f"{API}/gestures/{gid}", json={"is_active": False}, headers=admin)
    assert client.get(f"{API}/gestures").json() == []
    assert len(client.get(f"{API}/gestures?include_inactive=true", headers=admin).json()) == 1

    assert client.delete(f"{API}/gestures/{gid}", headers=admin).status_code == 204
    res = client.get(f"{API}/gestures/{gid}")
    assert res.status_code == 404
    assert res.json()["code"] == "gesture_not_found"


def test_phrases_and_quick_phrases(client, admin):
    res = client.post(
        f"{API}/phrases", json={"words": ["ман", "об"], "text_tj": "Ман об мехоҳам", "text_ru": "Я хочу воды"},
        headers=admin,
    )
    assert res.status_code == 201
    pid = res.json()["id"]
    client.patch(f"{API}/phrases/{pid}", json={"text_ru": "Хочу воды"}, headers=admin)
    assert client.get(f"{API}/phrases").json()[0]["text_ru"] == "Хочу воды"

    client.post(f"{API}/quick-phrases", json={"text_tj": "Ташаккур", "order": 2}, headers=admin)
    client.post(f"{API}/quick-phrases", json={"text_tj": "Ба ман бад аст", "order": 1}, headers=admin)
    texts = [q["text_tj"] for q in client.get(f"{API}/quick-phrases").json()]
    assert texts == ["Ба ман бад аст", "Ташаккур"]


def test_validation_error_format(client, admin):
    res = client.post(f"{API}/gestures", json={"name_tj": ""}, headers=admin)
    assert res.status_code == 422
    body = res.json()
    assert body["code"] == "validation"
    assert body["message"]["tg"] and body["message"]["ru"]
    assert body["errors"][0]["loc"] == ["body", "name_tj"]


def test_dictionary_offline_bundle(client, admin, gesture):
    client.post(f"{API}/quick-phrases", json={"text_tj": "Ташаккур"}, headers=admin)
    res = client.get(f"{API}/dictionary")
    assert res.status_code == 200
    body = res.json()
    assert body["gestures"][0]["name_tj"] == "Салом"
    assert body["quick_phrases"][0]["text_tj"] == "Ташаккур"
    assert body["model"] is None
    assert body["audio"] == []


def test_cors_only_for_frontend(client):
    ok = client.options(
        f"{API}/dictionary",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
    )
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    bad = client.get(f"{API}/dictionary", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in bad.headers


def test_unknown_route_is_localized(client):
    res = client.get(f"{API}/nope")
    assert res.status_code == 404
    assert res.json()["message"]["ru"] == "Не найдено."
