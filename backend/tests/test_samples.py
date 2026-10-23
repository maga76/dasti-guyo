import json

from tests.conftest import make_frames

API = "/api/v1"


def _post(client, headers, gesture_id, frames, hand_count=1):
    return client.post(
        f"{API}/samples", json={"gesture_id": gesture_id, "landmarks": frames, "hand_count": hand_count}, headers=headers
    )


def test_contributor_sample_needs_approval(client, admin, contributor, gesture):
    res = _post(client, contributor, gesture["id"], make_frames(30))
    assert res.status_code == 201
    sample = res.json()
    assert sample["is_approved"] is False
    assert sample["frame_count"] == 30

    # Одобрить может только админ
    assert client.patch(f"{API}/samples/{sample['id']}/approve", headers=contributor).status_code == 403
    res = client.patch(f"{API}/samples/{sample['id']}/approve", headers=admin)
    assert res.json()["is_approved"] is True

    # Можно и отменить одобрение
    res = client.patch(f"{API}/samples/{sample['id']}/approve", json={"is_approved": False}, headers=admin)
    assert res.json()["is_approved"] is False


def test_admin_sample_auto_approved_and_detail(client, admin, gesture):
    res = _post(client, admin, gesture["id"], make_frames(12), hand_count=2)
    assert res.json()["is_approved"] is True
    detail = client.get(f"{API}/samples/{res.json()['id']}", headers=admin).json()
    assert len(detail["landmarks"]) == 12
    assert len(detail["landmarks"][0]) == 132


def test_anonymous_cannot_post_samples(client, gesture):
    assert _post(client, {}, gesture["id"], make_frames(20)).status_code == 401


def test_wrong_frame_size(client, admin, gesture):
    frames = make_frames(20)
    frames[3] = frames[3][:100]
    res = _post(client, admin, gesture["id"], frames)
    assert res.status_code == 422
    assert res.json()["code"] == "frame_size"
    assert "132" in res.json()["message"]["ru"]


def test_too_few_frames(client, admin, gesture):
    res = _post(client, admin, gesture["id"], make_frames(3))
    assert res.status_code == 422
    assert res.json()["code"] == "frames_count"


def test_out_of_range_and_nan(client, admin, gesture):
    frames = make_frames(20)
    frames[0][0] = 1000.0
    assert _post(client, admin, gesture["id"], frames).status_code == 422

    # NaN нельзя передать обычным JSON, но Python-клиент может — проверяем
    frames = make_frames(20)
    body = json.dumps({"gesture_id": gesture["id"], "landmarks": frames, "hand_count": 1}).replace(
        str(frames[0][0]), "NaN", 1
    )
    res = client.post(f"{API}/samples", content=body, headers={**admin, "Content-Type": "application/json"})
    assert res.status_code == 422


def test_bad_hand_count_and_unknown_gesture(client, admin, gesture):
    assert _post(client, admin, gesture["id"], make_frames(20), hand_count=3).status_code == 422
    res = _post(client, admin, 9999, make_frames(20))
    assert res.status_code == 404
    assert res.json()["code"] == "gesture_not_found"


def test_body_too_large(client, admin, gesture):
    huge = {"gesture_id": gesture["id"], "landmarks": make_frames(20), "hand_count": 1, "pad": "x" * 2_000_000}
    res = client.post(f"{API}/samples", json=huge, headers=admin)
    assert res.status_code == 413
    assert res.json()["code"] == "body_too_large"


def test_list_filters_and_visibility(client, admin, contributor, gesture):
    _post(client, contributor, gesture["id"], make_frames(20))
    _post(client, admin, gesture["id"], make_frames(20))

    assert len(client.get(f"{API}/samples", headers=admin).json()) == 2
    # Волонтёр видит только свои примеры
    assert len(client.get(f"{API}/samples", headers=contributor).json()) == 1
    assert len(client.get(f"{API}/samples?approved=false", headers=admin).json()) == 1
    assert len(client.get(f"{API}/samples?gesture_id={gesture['id']}", headers=admin).json()) == 2


def test_delete_sample(client, admin, contributor, gesture):
    sid = _post(client, contributor, gesture["id"], make_frames(20)).json()["id"]
    assert client.delete(f"{API}/samples/{sid}", headers=contributor).status_code == 403
    assert client.delete(f"{API}/samples/{sid}", headers=admin).status_code == 204
    assert client.get(f"{API}/samples/{sid}", headers=admin).status_code == 404


def test_deleting_gesture_removes_samples(client, admin, gesture):
    sid = _post(client, admin, gesture["id"], make_frames(20)).json()["id"]
    client.delete(f"{API}/gestures/{gesture['id']}", headers=admin)
    assert client.get(f"{API}/samples/{sid}", headers=admin).status_code == 404
