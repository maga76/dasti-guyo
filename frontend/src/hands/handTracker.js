// Обнаружение рук через MediaPipe HandLandmarker: 21 точка на каждой руке.
// Сначала пробуем GPU (быстрее), если не получилось — CPU.

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { config } from '../config.js';

/**
 * @typedef {{x:number, y:number, z:number}} Point
 * @typedef {{side:'left'|'right', score:number, landmarks:Point[], world:Point[]}} Hand
 */

export class HandTracker {
  constructor() {
    /** @type {HandLandmarker|null} */
    this.landmarker = null;
    /** @type {'GPU'|'CPU'|null} */
    this.delegate = null;
  }

  get isReady() {
    return Boolean(this.landmarker);
  }

  /**
   * Загружает WASM и модель.
   * @param {(percent:number|null) => void} [onProgress] процент загрузки модели
   */
  async init(onProgress) {
    const [fileset, modelBuffer] = await Promise.all([
      FilesetResolver.forVisionTasks(config.mediapipe.wasmPath),
      loadModel(onProgress),
    ]);

    try {
      this.landmarker = await createLandmarker(fileset, modelBuffer, 'GPU');
      warmUp(this.landmarker); // некоторые видеокарты падают только на первом кадре
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('[hands] GPU недоступен, переключаюсь на CPU:', err);
      this.landmarker?.close();
      this.landmarker = await createLandmarker(fileset, modelBuffer, 'CPU');
      warmUp(this.landmarker);
      this.delegate = 'CPU';
    }
  }

  /**
   * Находит руки на текущем кадре видео.
   * @param {HTMLVideoElement} video
   * @param {number} timestamp монотонно растущее время, мс
   * @returns {Hand[]}
   */
  detect(video, timestamp) {
    const result = this.landmarker.detectForVideo(video, timestamp);
    // В разных версиях библиотеки поле называется по-разному
    const handedness = result.handedness ?? result.handednesses ?? [];
    return result.landmarks.map((landmarks, i) => {
      const category = handedness[i]?.[0];
      let side = category?.categoryName === 'Left' ? 'left' : 'right';
      if (config.mediapipe.swapHandedness) side = side === 'left' ? 'right' : 'left';
      return {
        side,
        score: category?.score ?? 0,
        landmarks,
        world: result.worldLandmarks?.[i] ?? [],
      };
    });
  }

  close() {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

function createLandmarker(fileset, modelBuffer, delegate) {
  const mp = config.mediapipe;
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: modelBuffer, delegate },
    runningMode: 'VIDEO',
    numHands: mp.numHands,
    minHandDetectionConfidence: mp.minDetectionConfidence,
    minHandPresenceConfidence: mp.minPresenceConfidence,
    minTrackingConfidence: mp.minTrackingConfidence,
  });
}

/** Пробный прогон на пустой картинке: проверяет, что выбранный делегат реально работает. */
function warmUp(landmarker) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  canvas.getContext('2d').fillRect(0, 0, 64, 64);
  landmarker.detectForVideo(canvas, performance.now());
}

/**
 * Загружает файл модели с прогрессом. Сначала локальная копия,
 * при её отсутствии — CDN. Модель большая (~7.5 МБ), поэтому прогресс важен.
 */
async function loadModel(onProgress) {
  const mp = config.mediapipe;
  for (const url of [mp.modelPath, mp.modelFallbackUrl]) {
    try {
      return await fetchWithProgress(url, onProgress);
    } catch (err) {
      console.warn(`[hands] Модель не загрузилась с ${url}:`, err.message);
    }
  }
  throw new Error('hand model unavailable');
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  // Dev-сервер на отсутствующий файл отвечает index.html — это не модель
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || type.includes('text/html')) throw new Error(`HTTP ${res.status} ${type}`);

  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) {
    onProgress?.(null);
    return new Uint8Array(await res.arrayBuffer());
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(Math.min(100, Math.round((received / total) * 100)));
  }
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer;
}
