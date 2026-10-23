API = "/api/v1"

# Начало настоящего webm-файла (сигнатура EBML) + немного данных
WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 2000


def _upload(client, headers, content=WEBM, content_type="audio/webm;codecs=opus", **form):
    return client.post(
        f"{API}/audio", files={"file": ("word.webm", content, content_type)}, data=form, headers=headers
    )


def test_upload_and_download(client, contributor, gesture):
    res = _upload(client, contributor, gesture_id=gesture["id"])
    assert res.status_code == 201, res.text
    clip = res.json()
    assert clip["content_type"] == "audio/webm"
    assert clip["url"].endswith(f"/api/v1/audio/{clip['id']}")

    file = client.get(f"{API}/audio/{clip['id']}")
    assert file.status_code == 200
    assert file.content == WEBM
    assert file.headers["content-type"].startswith("audio/webm")

    # Запись появляется в офлайн-словаре
    assert client.get(f"{API}/dictionary").json()["audio"][0]["id"] == clip["id"]


def test_wrong_type_rejected(client, contributor, gesture):
    res = _upload(client, contributor, content=b"MZ\x90\x00" * 10, content_type="application/x-msdownload", gesture_id=gesture["id"])
    assert res.status_code == 415
    assert res.json()["code"] == "audio_bad_type"


def test_fake_audio_rejected(client, contributor, gesture):
    # Заголовок «audio/webm», но внутри не аудио
    res = _upload(client, contributor, content=b"<script>alert(1)</script>", gesture_id=gesture["id"])
    assert res.status_code == 415


def test_too_large_rejected(client, contributor, gesture):
    res = _upload(client, contributor, content=WEBM + b"\x00" * (2 * 1024 * 1024), gesture_id=gesture["id"])
    assert res.status_code == 413


def test_needs_exactly_one_target(client, admin, contributor, gesture):
    phrase = client.post(f"{API}/phrases", json={"words": ["a"], "text_tj": "А"}, headers=admin).json()
    assert _upload(client, contributor).status_code == 422
    res = _upload(client, contributor, gesture_id=gesture["id"], phrase_id=phrase["id"])
    assert res.status_code == 422
    assert res.json()["code"] == "audio_target"
    assert _upload(client, contributor, phrase_id=phrase["id"]).status_code == 201


def test_anonymous_cannot_upload(client, gesture):
    assert _upload(client, {}, gesture_id=gesture["id"]).status_code == 401


def test_admin_deletes_audio(client, admin, gesture):
    clip = _upload(client, admin, gesture_id=gesture["id"]).json()
    assert client.delete(f"{API}/audio/{clip['id']}", headers=admin).status_code == 204
    assert client.get(f"{API}/audio/{clip['id']}").status_code == 404
