import numpy as np
import pytest
from sklearn.neural_network import MLPClassifier

from app.core.config import get_settings
from app.services.tfjs_export import export_mlp_to_tfjs, load_tfjs_dense, predict_with_layers
from app.services.training import training_manager
from tests.conftest import make_frames

API = "/api/v1"


def _add_gesture(client, admin, name, center, samples=20, frames=10):
    gid = client.post(f"{API}/gestures", json={"name_tj": name}, headers=admin).json()["id"]
    for i in range(samples):
        res = client.post(
            f"{API}/samples",
            json={"gesture_id": gid, "landmarks": make_frames(frames, center, seed=hash((name, i)) % 10_000), "hand_count": 1},
            headers=admin,
        )
        assert res.status_code == 201
    return gid


def _train(client, admin, **body):
    res = client.post(f"{API}/models/train", json=body, headers=admin)
    assert res.status_code == 202, res.text
    training_manager.wait()
    status = client.get(f"{API}/models/train/status", headers=admin).json()
    assert status["state"] == "done", status
    return status


@pytest.mark.parametrize("n_classes", [2, 3])
def test_tfjs_export_matches_sklearn(tmp_path, n_classes):
    """Экспортированные веса дают те же вероятности, что и sklearn (в т.ч. для 2 классов)."""
    rng = np.random.default_rng(0)
    X = rng.normal(size=(300, 126)).astype(np.float32)
    y = rng.integers(0, n_classes, 300)
    clf = MLPClassifier(hidden_layer_sizes=(16,), max_iter=50, random_state=0).fit(X, y)
    export_mlp_to_tfjs(clf, tmp_path, [str(i) for i in range(n_classes)])

    probs = predict_with_layers(load_tfjs_dense(tmp_path), X[:20])
    assert probs.shape == (20, n_classes)
    np.testing.assert_allclose(probs, clf.predict_proba(X[:20]), atol=1e-4)


def test_train_requires_admin(client, contributor):
    assert client.post(f"{API}/models/train", headers=contributor).status_code == 403


def test_not_enough_samples(client, admin):
    _add_gesture(client, admin, "Салом", 0.0, samples=20)
    _add_gesture(client, admin, "Об", 1.0, samples=5)
    res = client.post(f"{API}/models/train", headers=admin)
    assert res.status_code == 400
    body = res.json()
    assert body["code"] == "not_enough_samples"
    assert "20" in body["message"]["ru"]
    assert body["errors"] == [{"gesture_id": body["errors"][0]["gesture_id"], "name_tj": "Об", "approved": 5}]


def test_needs_two_gestures(client, admin):
    _add_gesture(client, admin, "Салом", 0.0)
    res = client.post(f"{API}/models/train", headers=admin)
    assert res.json()["code"] == "not_enough_gestures"


def test_train_publish_and_latest(client, admin):
    _add_gesture(client, admin, "Салом", 0.0)
    _add_gesture(client, admin, "Об", 1.0)
    assert client.get(f"{API}/models/latest").status_code == 404

    status = _train(client, admin)
    assert status["accuracy"] > 0.9  # классы легко различимы
    assert status["published"] is False

    model_id = status["model_version_id"]
    res = client.post(f"{API}/models/{model_id}/publish", headers=admin)
    assert res.status_code == 200

    latest = client.get(f"{API}/models/latest").json()
    assert latest["version"] == 1
    assert [g["name_tj"] for g in latest["gesture_list"]] == ["Салом", "Об"]

    # Файлы модели раздаются как статика
    model_json = client.get(latest["model_url"])
    assert model_json.status_code == 200
    assert model_json.json()["format"] == "layers-model"
    weights = client.get(latest["model_url"].replace("model.json", "weights.bin"))
    assert weights.status_code == 200
    assert (get_settings().models_dir / "v1" / "weights.bin").is_file()

    # Модель попадает в офлайн-словарь
    assert client.get(f"{API}/dictionary").json()["model"]["version"] == 1


def test_worse_model_is_not_published(client, admin):
    _add_gesture(client, admin, "Салом", 0.0)
    _add_gesture(client, admin, "Об", 1.0)
    first = _train(client, admin, auto_publish=True)
    assert first["published"] is True

    # Портим данные: новый жест неотличим от старого → точность падает
    _add_gesture(client, admin, "Нон", 0.0)
    second = _train(client, admin, auto_publish=True)
    assert second["accuracy"] < first["accuracy"]
    assert second["published"] is False

    res = client.post(f"{API}/models/{second['model_version_id']}/publish", headers=admin)
    assert res.status_code == 409
    assert res.json()["code"] == "model_worse"

    # Принудительно — можно
    forced = client.post(f"{API}/models/{second['model_version_id']}/publish?force=true", headers=admin)
    assert forced.status_code == 200
    assert client.get(f"{API}/models/latest").json()["version"] == 2


def test_stats(client, admin, contributor, gesture):
    client.post(
        f"{API}/samples", json={"gesture_id": gesture["id"], "landmarks": make_frames(20), "hand_count": 1}, headers=contributor
    )
    stats = client.get(f"{API}/stats", headers=admin).json()
    assert stats["users"] == {"admin": 1, "contributor": 1}
    assert stats["samples_pending"] == 1
    assert stats["per_gesture"][0]["name_tj"] == "Салом"
    assert client.get(f"{API}/stats", headers=contributor).status_code == 403
