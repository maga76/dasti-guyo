from fastapi import APIRouter, status
from sqlalchemy import select

from app.api.deps import DB, Admin, get_or_404
from app.core.errors import AppError
from app.core.security import hash_password
from app.models import User
from app.schemas.users import UserCreate, UserOut, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserOut])
def list_users(db: DB, _: Admin):
    return db.scalars(select(User).order_by(User.id)).all()


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(data: UserCreate, db: DB, _: Admin):
    if db.scalar(select(User).where(User.username == data.username)):
        raise AppError(409, "user_exists")
    user = User(username=data.username, password_hash=hash_password(data.password), role=data.role)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: int, data: UserUpdate, db: DB, _: Admin):
    user = get_or_404(db, User, user_id, "user_not_found")
    if data.password:
        user.password_hash = hash_password(data.password)
    if data.role:
        user.role = data.role
    db.commit()
    db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(user_id: int, db: DB, admin: Admin):
    user = get_or_404(db, User, user_id, "user_not_found")
    if user.id == admin.id:
        raise AppError(400, "cannot_delete_self")
    db.delete(user)
    db.commit()
