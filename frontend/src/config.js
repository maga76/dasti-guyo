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
    // Порог обнаружения выше 0.5 теряет настоящие руки (проверено на кадрах аватара: при 0.6–0.7
    // пропадали руки в «Хуб», «Чӣ», «Падар»). Поэтому ложные «руки» (лицо, волосы) отсеиваются
    // иначе — см. minHandScore, stableFrames и looksLikeHand в handTracker.js
    minDetectionConfidence: 0.5,
    minPresenceConfidence: 0.6,
    minTrackingConfidence: 0.5,
    // Насколько уверенно MediaPipe определил левая/правая. Слабый признак: у далёкой настоящей руки
    // бывает 0.53, а у узора на флаге — 0.98; отсекает только совсем сомнительное
    minHandScore: 0.5,
    // Поза тела: кисть засчитывается, если до запястья человека не больше стольких размеров кисти
    poseModelPath: `${base}models/pose_landmarker_lite.task`,
    poseModelUrl:
      'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    bodyHandDistance: 2,
    // Рука засчитывается, если держится столько кадров подряд: ложная «рука» на лице обычно мелькает
    stableFrames: 3,
    // MediaPipe считает, что кадр уже отзеркален (как селфи). Мы подаём
    // в модель исходный кадр, поэтому «Left»/«Right» надо поменять местами.
    swapHandedness: true,
  },

  camera: {
    // 640×480 — хороший баланс точности и скорости, в том числе для телефонов.
    // 60 кадров/с — если камера умеет (иначе браузер даст 30): кадр каждые 16 мс вместо 33,
    // скелет меньше отстаёт от руки; лишние кадры распознавание само пропускает, если не успевает
    width: 640,
    height: 480,
    frameRate: 60,
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
