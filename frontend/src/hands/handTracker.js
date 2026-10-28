// Обнаружение рук: MediaPipe HandLandmarker, 21 точка на каждой руке (само распознавание и
// отсев ложных рук — handCore.js).
//
// Обычно распознавание идёт в фоновом потоке (handWorker.js): страница отдаёт ему кадр и не ждёт,
// поэтому интерфейс, анимации и 3D-аватар не подтормаживают. Если браузер не умеет фоновые потоки
// с OffscreenCanvas (старые Safari) или поток не запустился — распознаём на странице, как раньше.
//
// WASM (~13 МБ) и модели качаются здесь, надёжно: CDN → наш сервер, с повторами (net/download.js).
// Поза тела (для отсева ложных рук) грузится в фоне после рук и не задерживает запуск.

import { FilesetResolver } from '@mediapipe/tasks-vision';
import { config } from '../config.js';
import { download, mediapipeWasmBases } from '../net/download.js';

// Кадр для фонового потока уменьшаем до этой ширины: точки рук — в долях кадра и не меняются,
// а копировать и распознавать маленький кадр быстрее
const WORKER_FRAME_WIDTH = 960;
const WORKER_START_TIMEOUT_MS = 60_000;

/** @typedef {import('./handCore.js').Hand} Hand */

const canUseWorker = () =>
  typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';

const videoAspect = (video) => (video.videoWidth || video.width) / (video.videoHeight || video.height) || 4 / 3;

export class HandTracker {
  constructor() {
    /** @type {Worker|null} фоновый поток (обычный путь) */
    this.worker = null;
    /** @type {import('./handCore.js').HandCore|null} распознавание на странице (запасной путь) */
    this.core = null;
    /** @type {'GPU'|'CPU'|null} */
    this.delegate = null;
    this.nextId = 0;
    this.waiting = new Map(); // номер кадра → resolve ответа потока
  }

  get isReady() {
    return Boolean(this.worker || this.core);
  }

  /** Распознавание идёт в фоновом потоке. */
  get inWorker() {
    return Boolean(this.worker);
  }

  /**
   * Загружает WASM и модель и запускает распознавание.
   * @param {(percent:number|null) => void} [onProgress] процент загрузки модели
   */
  async init(onProgress) {
    const modelPromise = loadModel(onProgress);
    if (canUseWorker()) {
      try {
        // Фоновому потоку нужен вариант WASM-загрузчика в виде модуля
        const [fileset, model] = await Promise.all([loadWasm(true), modelPromise]);
        await this.startWorker(fileset, model);
        this.initPose(fileset); // в фоне
        return;
      } catch (err) {
        console.warn('[hands] Фоновый поток недоступен — распознаю на странице:', err);
      }
    }
    const [{ HandCore }, fileset, model] = await Promise.all([import('./handCore.js'), loadWasm(false), modelPromise]);
    this.core = new HandCore();
    this.delegate = await this.core.create(fileset, model);
    this.initPose(fileset); // в фоне
  }

  startWorker(fileset, model) {
    const worker = new Worker(new URL('./handWorker.js', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      const fail = (err) => {
        clearTimeout(timer);
        worker.terminate();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('фоновый поток не ответил')), WORKER_START_TIMEOUT_MS);
      worker.onerror = (e) => fail(new Error(e.message || 'ошибка фонового потока'));
      worker.onmessage = ({ data }) => {
        if (data.type === 'error') return fail(new Error(data.message));
        if (data.type !== 'ready') return;
        clearTimeout(timer);
        this.worker = worker;
        this.delegate = data.delegate;
        worker.onmessage = (e) => this.onWorkerMessage(e.data);
        worker.onerror = (e) => console.error('[hands] Ошибка фонового потока:', e.message);
        resolve();
      };
      // Копия модели: если поток не запустится, оригинал понадобится странице
      const copy = model.slice();
      worker.postMessage({ type: 'init', fileset, model: copy.buffer }, [copy.buffer]);
    });
  }

  onWorkerMessage(data) {
    if (data.type !== 'hands') return;
    const resolve = this.waiting.get(data.id);
    this.waiting.delete(data.id);
    resolve?.(data);
  }

  async initPose(fileset) {
    const mp = config.mediapipe;
    try {
      const buffer = await download(import.meta.env.DEV ? [mp.poseModelPath, mp.poseModelUrl] : [mp.poseModelUrl, mp.poseModelPath], {
        cacheKey: mp.poseModelUrl,
      });
      if (this.worker) this.worker.postMessage({ type: 'pose', fileset, buffer }); // копией: файл мог остаться в памяти загрузчика
      else await this.core.createPose(fileset, buffer);
    } catch (err) {
      console.warn('[hands] Поза тела не загрузилась — ложные руки отсеиваются без неё:', err);
    }
  }

  /**
   * Находит руки на текущем кадре видео.
   * @param {HTMLVideoElement} video
   * @param {number} timestamp монотонно растущее время, мс
   * @returns {Promise<Hand[]>|Hand[]} в фоновом потоке — обещание, на странице — сразу
   */
  detect(video, timestamp) {
    const aspect = videoAspect(video);
    if (!this.worker) return this.core.detect(video, timestamp, aspect);
    return this.detectInWorker(video, timestamp, aspect);
  }

  async detectInWorker(video, timestamp, aspect) {
    const width = Math.min(WORKER_FRAME_WIDTH, video.videoWidth || WORKER_FRAME_WIDTH);
    const bitmap = await createImageBitmap(video, {
      resizeWidth: width,
      resizeHeight: Math.round(width / aspect),
      resizeQuality: 'low',
    });
    const id = ++this.nextId;
    const reply = await new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ type: 'detect', id, bitmap, timestamp, aspect }, [bitmap]);
    });
    if (reply.error) throw new Error(reply.error);
    return reply.hands;
  }

  close() {
    this.worker?.terminate();
    this.core?.close();
    this.worker = null;
    this.core = null;
  }
}

/**
 * WASM MediaPipe: имена файлов подбирает сама библиотека (с SIMD или без), а скачиваем
 * их мы — надёжно — и отдаём библиотеке как blob-адреса.
 * @param {boolean} asModule загрузчик в виде модуля (для фонового потока)
 */
async function loadWasm(asModule) {
  const bases = mediapipeWasmBases();
  const names = await FilesetResolver.forVisionTasks(bases[0], asModule);
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
