from fastapi import APIRouter

from app.api.routes import audio, auth, dictionary, me, models, samples, stats, tts, users

api_router = APIRouter()


@api_router.get("/health", tags=["health"], summary="Проверка связи (фронтенд: онлайн/офлайн)")
def health():
    return {"status": "ok"}


for module in (auth, users, dictionary, samples, audio, models, stats, tts, me):
    api_router.include_router(module.router)
