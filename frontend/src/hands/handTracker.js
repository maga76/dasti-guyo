// Обнаружение рук через MediaPipe HandLandmarker: 21 точка на каждой руке.
// Сначала пробуем GPU (быстрее), если не получилось — CPU.
// WASM (~13 МБ) и модель (~7.5 МБ) качаются надёжно: CDN → наш сервер, с повторами (net/download.js).
//
// Ложные руки (лицо в профиль, узор на флаге) отсеиваются позой тела (PoseLandmarker lite):
// настоящая кисть всегда у запястья человека. Поза грузится в фоне после рук и не задерживает запуск;
// пока её нет (или человека не видно целиком) — проверка по позе не делается.

import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import { config } from '../config.js';
import { download, mediapipeWasmBases } from '../net/download.js';

// Точки позы у кистей: запястье, мизинец, указательный, большой — левая (15…21) и правая (16…22)
const POSE_HAND_POINTS = [15, 17, 19, 21, 16, 18, 20, 22];
const POSE_EVERY = 3; // поза меняется медленнее кистей — достаточно каждого третьего кадра
const POSE_MAX_AGE_MS = 600;

/**
 * Рядом ли кисть с запястьем человека (по позе тела).
 * @param {{x:number,y:number}[]} hand 21 точка кисти
 * @param {{x:number,y:number}[]} pose 33 точки позы
 * @param {number} aspect ширина / высота кадра
 */
export function nearBodyHand(hand, pose, aspect) {
  const d = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
  // Размер кисти — наибольшее из длины и ширины ладони; не меньше 3% высоты кадра
  const size = Math.max(d(hand[0], hand[9]), d(hand[5], hand[17]), 0.03);
  const center = { x: (hand[0].x + hand[9].x) / 2, y: (hand[0].y + hand[9].y) / 2 };
  const nearest = Math.min(...POSE_HAND_POINTS.map((i) => Math.min(d(hand[0], pose[i]), d(center, pose[i]))));
  return nearest < config.mediapipe.bodyHandDistance * size;
}

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
    this.initPose(fileset); // в фоне
  }

  async initPose(fileset) {
    const mp = config.mediapipe;
    try {
      const buffer = await download(import.meta.env.DEV ? [mp.poseModelPath, mp.poseModelUrl] : [mp.poseModelUrl, mp.poseModelPath], {
        cacheKey: mp.poseModelUrl,
      });
      this.pose = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: new Uint8Array(buffer), delegate: this.delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    } catch (err) {
      console.warn('[hands] Поза тела не загрузилась — ложные руки отсеиваются без неё:', err);
    }
  }

  /** Последняя поза человека (обновляется каждые POSE_EVERY кадров) или null. */
  bodyPose(video, timestamp) {
    if (!this.pose) return null;
    this.poseTick = (this.poseTick ?? 0) + 1;
    if (this.poseTick % POSE_EVERY === 0) {
      try {
        const result = this.pose.detectForVideo(video, timestamp);
        this.lastPose = result.landmarks?.[0] ?? null;
        this.lastPoseAt = timestamp;
      } catch {
        this.lastPose = null;
      }
    }
    return timestamp - (this.lastPoseAt ?? -Infinity) < POSE_MAX_AGE_MS ? this.lastPose : null;
  }

  /**
   * Находит руки на текущем кадре видео.
   * @param {HTMLVideoElement} video
   * @param {number} timestamp монотонно растущее время, мс
   * @returns {Hand[]}
   */
  detect(video, timestamp) {
    const result = this.landmarker.detectForVideo(video, timestamp);
    const mp = config.mediapipe;
    const aspect = (video.videoWidth || video.width) / (video.videoHeight || video.height) || 4 / 3;
    // В разных версиях библиотеки поле называется по-разному
    const handedness = result.handedness ?? result.handednesses ?? [];
    const hands = result.landmarks
      .map((landmarks, i) => {
        const category = handedness[i]?.[0];
        let side = category?.categoryName === 'Left' ? 'left' : 'right';
        if (mp.swapHandedness) side = side === 'left' ? 'right' : 'left';
        return {
          side,
          score: category?.score ?? 0,
          landmarks,
          world: result.worldLandmarks?.[i] ?? [],
        };
      })
      .filter((hand) => hand.score >= mp.minHandScore && looksLikeHand(hand.landmarks, aspect));
    // Человек виден — кисть должна быть у его запястья (иначе это лицо, узор, предмет)
    const body = hands.length ? this.bodyPose(video, timestamp) : null;
    const real = body ? hands.filter((hand) => nearBodyHand(hand.landmarks, body, aspect)) : hands;
    return this.stable(real);
  }

  /** Рука «появилась», только если её видно stableFrames кадров подряд. */
  stable(hands) {
    this.streak ??= { left: 0, right: 0 };
    for (const side of ['left', 'right']) {
      this.streak[side] = hands.some((h) => h.side === side) ? this.streak[side] + 1 : 0;
    }
    return hands.filter((h) => this.streak[h.side] >= config.mediapipe.stableFrames);
  }

  close() {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

/**
 * Пропорции похожи на кисть? У ложных срабатываний (лицо, волосы, узор одежды) точки часто
 * сбиваются в комок или растягиваются: пальцы короче половины ладони или длиннее двух с половиной.
 * @param {{x:number, y:number}[]} p 21 точка (x, y — доли ширины и высоты кадра)
 * @param {number} aspect ширина / высота кадра
 */
// Пределы проверены на 30 865 руках из записей Slovo: отбрасывается 0.06% настоящих рук
export function looksLikeHand(p, aspect) {
  const d = (a, b) => Math.hypot((p[a].x - p[b].x) * aspect, p[a].y - p[b].y);
  const palm = d(0, 9);
  // Крошечная «рука» — шум. Кисть, направленная пальцами в камеру, в кадре короткая,
  // поэтому размер — наибольшее из длины и ширины ладони
  if (Math.max(palm, d(5, 17), d(0, 5), d(0, 17)) < 0.01) return false;
  const chain = (ids) => ids.slice(1).reduce((sum, id, i) => sum + d(ids[i], id), 0);
  // Пальцы не длиннее двух с половиной ладоней (ладонь — наибольшее из длины и ширины)
  const ref = Math.max(palm, d(5, 17));
  for (const ids of [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]) {
    if (chain(ids) > 2.5 * ref) return false;
  }
  // Ладонь не вдвое шире своей длины
  return d(5, 17) < 2 * Math.max(palm, d(0, 5), d(0, 17));
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
