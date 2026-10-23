"""Начальные данные: служебный класс «нет жеста» и быстрые фразы.

Запуск: python -m app.scripts.seed  (повторный запуск ничего не дублирует)

Важно: жесты (слова) здесь НЕ создаются. Настоящие жесты таджикского
жестового языка добавляют администраторы вместе с носителями языка.
"""

from sqlalchemy import select

from app.core.config import NONE_CATEGORY
from app.core.database import SessionLocal
from app.main import run_migrations
from app.models import Gesture, QuickPhrase

NONE_GESTURE = {
    "name_tj": "Бе имо",
    "name_ru": "Нет жеста",
    "category": NONE_CATEGORY,
    "description": "Руки опущены, почёсывание, случайные движения. Нужен, чтобы модель не угадывала жест там, где его нет.",
}

# Это текстовые фразы для кнопок, а не жесты
QUICK_PHRASES = [
    ("Салом", "Здравствуйте"),
    ("Ман намешунавам", "Я не слышу"),
    ("Ба ман бад аст", "Мне плохо"),
    ("Ёрии таъҷилиро даъват кунед", "Вызовите скорую помощь"),
    ("Ҳоҷатхона дар куҷост?", "Где туалет?"),
    ("Лутфан, нависед", "Пожалуйста, напишите"),
    ("Лутфан, оҳистатар", "Пожалуйста, помедленнее"),
    ("Ҳа", "Да"),
    ("Не", "Нет"),
    ("Ташаккур", "Спасибо"),
]


def main() -> None:
    run_migrations()
    with SessionLocal() as db:
        if not db.scalar(select(Gesture).where(Gesture.category == NONE_CATEGORY)):
            db.add(Gesture(**NONE_GESTURE))
            print("Добавлен класс «нет жеста».")
        existing = set(db.scalars(select(QuickPhrase.text_tj)))
        added = 0
        for order, (tj, ru) in enumerate(QUICK_PHRASES):
            if tj not in existing:
                db.add(QuickPhrase(text_tj=tj, text_ru=ru, order=order))
                added += 1
        db.commit()
        print(f"Добавлено быстрых фраз: {added}.")


if __name__ == "__main__":
    main()
