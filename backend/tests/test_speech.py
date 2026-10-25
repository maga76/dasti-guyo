"""Тренажёр произношения «Талаффуз»: попытки и прогресс в профиле."""

from tests.test_profile import API, auth, register


def say(client, headers, word, score, heard=None):
    return client.post(f"{API}/me/speech", json={"word": word, "score": score, "heard": heard}, headers=headers)


def test_speech_requires_login(client):
    assert client.post(f"{API}/me/speech", json={"word": "Салом", "score": 0.9}).status_code == 401


def test_speech_validation(client):
    headers = auth(register(client))
    assert say(client, headers, "Салом", 1.5).status_code == 422
    assert say(client, headers, "Салом", -0.1).status_code == 422
    assert say(client, headers, "", 0.5).status_code == 422
    assert say(client, headers, "Салом", 0.5, heard="х" * 201).status_code == 422


def test_speech_ok_threshold(client):
    headers = auth(register(client))
    assert say(client, headers, "Салом", 0.74).json()["ok"] is False
    res = say(client, headers, "Салом", 0.75, heard="салам")
    assert res.status_code == 201
    assert res.json()["ok"] is True


def test_profile_speech_empty(client):
    headers = auth(register(client))
    speech = client.get(f"{API}/me/profile", headers=headers).json()["speech"]
    assert speech == {"attempts": 0, "correct": 0, "mastered_words": 0, "words": [], "history": []}


def test_profile_speech_progress(client):
    headers = auth(register(client))
    # Салом: ошибка, потом два раза верно → освоено
    for score in (0.5, 0.8, 0.9):
        say(client, headers, "Салом", score)
    # Об: верно, потом ошибка → последняя неудачная, не освоено
    say(client, headers, "об", 0.9)
    say(client, headers, "Об", 0.6)
    # Қалам: одна удачная попытка — мало
    say(client, headers, "Қалам", 0.95)

    data = client.get(f"{API}/me/profile", headers=headers).json()
    speech = data["speech"]
    assert speech["attempts"] == 6
    assert speech["correct"] == 4
    assert speech["mastered_words"] == 1
    words = {w["word"]: w for w in speech["words"]}
    assert set(words) == {"Салом", "Об", "Қалам"}  # без учёта регистра, написание — последней попытки
    assert words["Салом"] == {"word": "Салом", "attempts": 3, "correct": 2, "best": 0.9, "last": 0.9, "mastered": True}
    assert words["Об"]["attempts"] == 2 and words["Об"]["mastered"] is False and words["Об"]["last"] == 0.6
    assert words["Қалам"]["mastered"] is False
    assert speech["words"][0]["word"] == "Салом"  # освоенные — первыми
    assert [h["word"] for h in speech["history"]] == ["Салом", "Салом", "Салом", "об", "Об", "Қалам"]
    # Баллы: 4 удачные попытки × 2 + 1 освоенное слово × 10
    assert data["points"] == 4 * 2 + 10


def test_speech_history_limited(client):
    headers = auth(register(client))
    for i in range(35):
        say(client, headers, f"калима{i}", 0.5)
    history = client.get(f"{API}/me/profile", headers=headers).json()["speech"]["history"]
    assert len(history) == 30
    assert history[0]["word"] == "калима5" and history[-1]["word"] == "калима34"
