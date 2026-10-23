// Общие настройки фронтенда. Всё, что может понадобиться поменять, — здесь.

const base = import.meta.env.BASE_URL;

export const config = {
  // Адрес API. По умолчанию — тот же сайт: в разработке Vite проксирует /api на бэкенд,
  // при выкладке бэкенд сам отдаёт сайт. Для отдельного сервера API задайте VITE_API_URL.
  apiUrl: import.meta.env.VITE_API_URL || '/api/v1',

  mediapipe: {
    // WASM и модель лежат локально (их кладёт scripts/fetch-assets.mjs)
    wasmPath: `${base}mediapipe/wasm`,
    modelPath: `${base}models/hand_landmarker.task`,
    // Запасной адрес модели, если локальной копии нет
    modelFallbackUrl:
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    numHands: 2,
    minDetectionConfidence: 0.5,
    minPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    // MediaPipe считает, что кадр уже отзеркален (как селфи). Мы подаём
    // в модель исходный кадр, поэтому «Left»/«Right» надо поменять местами.
    swapHandedness: true,
  },

  camera: {
    // 640×480 — хороший баланс точности и скорости, в том числе для телефонов
    width: 640,
    height: 480,
    frameRate: 30,
  },

  perf: {
    // Сколько миллисекунд на кадр можно тратить на распознавание.
    // Если модель работает дольше — анализируем не каждый кадр.
    budgetMs: 25,
    maxSkip: 4,
    // Как часто пересчитывать пропуск кадров, мс
    adaptEveryMs: 1000,
  },
};
