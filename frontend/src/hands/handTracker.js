// Обнаружение рук через MediaPipe HandLandmarker: 21 точка на каждой руке.
// Сначала пробуем GPU (быстрее), если не получилось — CPU.
// WASM (~13 МБ) и модель (~7.5 МБ) качаются надёжно: CDN → наш сервер, с повторами (net/download.js).

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { config } from '../config.js';
import { download, mediapipeWasmBases } from '../net/download.js';

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
    const [fileset, modelBuffer] = await Promise.all([loadWasm(), loadModel(onProgress)]);

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
 * WASM MediaPipe: имена файлов подбирает сама библиотека (с SIMD или без), а скачиваем
 * их мы — надёжно — и отдаём библиотеке как blob-адреса.
 */
async function loadWasm() {
  const bases = mediapipeWasmBases();
  const names = await FilesetResolver.forVisionTasks(bases[0]);
  const file = (path) => path.split('/').pop();
  const blobUrl = async (name, type) => {
    const buffer = await download(bases.map((b) => `${b}/${name}`));
    return URL.createObjectURL(new Blob([buffer], { type }));
  };
  const [wasmLoaderPath, wasmBinaryPath] = await Promise.all([
    blobUrl(file(names.wasmLoaderPath), 'text/javascript'),
    blobUrl(file(names.wasmBinaryPath), 'application/wasm'),
  ]);
  return { ...names, wasmLoaderPath, wasmBinaryPath };
}

/** Модель руки (~7.5 МБ): наш сервер / CDN Google, с прогрессом. */
async function loadModel(onProgress) {
  const mp = config.mediapipe;
  // На CDN jsDelivr модели нет (её нет в git), поэтому первым — CDN Google, где она опубликована
  const urls = import.meta.env.DEV ? [mp.modelPath, mp.modelFallbackUrl] : [mp.modelFallbackUrl, mp.modelPath];
  return new Uint8Array(await download(urls, { onProgress, cacheKey: mp.modelFallbackUrl }));
}
