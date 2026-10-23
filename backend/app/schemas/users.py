from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.user import Role


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    role: Role
    created_at: datetime


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=50, pattern=r"^[\w.\-]+$")
    password: str = Field(min_length=8, max_length=72)
    role: Role = Role.contributor


class UserUpdate(BaseModel):
    password: str | None = Field(default=None, min_length=8, max_length=72)
    role: Role | None = None
