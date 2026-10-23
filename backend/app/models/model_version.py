from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.user import utcnow


class ModelVersion(Base):
    """Обученная модель. Файлы (model.json + weights.bin в формате TensorFlow.js)
    лежат в media/models/v{version}/."""

    __tablename__ = "model_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    version: Mapped[int] = mapped_column(Integer, unique=True)
    accuracy: Mapped[float] = mapped_column(Float)
    # Порядок классов = порядок выходов модели: [{id, name_tj, name_ru, category}, ...]
    gesture_list: Mapped[list[dict]] = mapped_column(JSON)
    file_path: Mapped[str] = mapped_column(String(300))  # относительно media/
    is_published: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
