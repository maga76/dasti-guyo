"""Создание (или сброс пароля) администратора.

Запуск из папки backend:
    python -m app.scripts.create_admin                  # данные из .env
    python -m app.scripts.create_admin --username ali   # пароль спросит
"""

import argparse
import getpass
import sys

from sqlalchemy import select

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.core.security import hash_password
from app.main import run_migrations
from app.models import Role, User


def main() -> None:
    settings = get_settings()
    parser = argparse.ArgumentParser(description="Создать администратора")
    parser.add_argument("--username", default=settings.first_admin_username)
    parser.add_argument("--password", default=None, help="лучше не указывать: спросит без отображения")
    args = parser.parse_args()

    password = args.password or settings.first_admin_password
    if not password:
        password = getpass.getpass("Пароль администратора: ")
    if len(password) < 8:
        sys.exit("Ошибка: пароль должен быть не короче 8 символов.")

    run_migrations()
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == args.username))
        if user:
            user.password_hash = hash_password(password)
            user.role = Role.admin
            action = "обновлён"
        else:
            db.add(User(username=args.username, password_hash=hash_password(password), role=Role.admin))
            action = "создан"
        db.commit()
    print(f"Администратор «{args.username}» {action}.")


if __name__ == "__main__":
    main()
