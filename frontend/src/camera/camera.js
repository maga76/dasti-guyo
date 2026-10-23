// Работа с камерой: запуск, остановка, переключение, понятные коды ошибок.

import { config } from '../config.js';

/** Ошибка камеры с кодом, по которому UI выбирает текст сообщения. */
export class CameraError extends Error {
  /**
   * @param {'insecure'|'unsupported'|'denied'|'notFound'|'busy'|'unknown'} code
   * @param {unknown} [cause]
   */
  constructor(code, cause) {
    super(code);
    this.name = 'CameraError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Проверка до запроса камеры. Возвращает код проблемы или null, если всё хорошо.
 * Камера работает только в «безопасном контексте»: https:// или localhost.
 */
export function checkCameraSupport() {
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  return null;
}

/** Переводит ошибку браузера в наш код. */
function toCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new CameraError('denied', err);
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new CameraError('notFound', err);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('busy', err);
    default:
      return new CameraError('unknown', err);
  }
}

export class Camera {
  /** @param {HTMLVideoElement} video */
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.deviceId = null;
    /** Вызывается, если камера пропала во время работы (выдернули провод и т.п.) */
    this.onEnded = null;
  }

  get isRunning() {
    return Boolean(this.stream);
  }

  /** Фронтальная камера (или веб-камера ноутбука) — показываем зеркально. */
  get isFrontFacing() {
    const settings = this.stream?.getVideoTracks()[0]?.getSettings() ?? {};
    return settings.facingMode !== 'environment';
  }

  /**
   * Включает камеру.
   * @param {{deviceId?: string}} [opts] конкретная камера; без неё — фронтальная
   */
  async start(opts = {}) {
    const problem = checkCameraSupport();
    if (problem) throw new CameraError(problem);

    this.stop();
    const { width, height, frameRate } = config.camera;
    const video = {
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: frameRate },
    };
    if (opts.deviceId) video.deviceId = { exact: opts.deviceId };
    else video.facingMode = 'user';

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      throw toCameraError(err);
    }

    const track = this.stream.getVideoTracks()[0];
    this.deviceId = track.getSettings().deviceId ?? null;
    track.addEventListener('ended', () => {
      this.stop();
      this.onEnded?.();
    });

    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    // Ждём, пока станут известны размеры кадра
    if (!this.video.videoWidth) {
      await new Promise((resolve) =>
        this.video.addEventListener('loadedmetadata', resolve, { once: true }),
      );
    }
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** Список камер. Названия доступны только после разрешения доступа. */
  static async listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  /** Переключает на следующую камеру по кругу (телефон: фронтальная ↔ задняя). */
  async switchToNext() {
    const cameras = await Camera.listCameras();
    if (cameras.length < 2) return;
    const index = cameras.findIndex((c) => c.deviceId === this.deviceId);
    const next = cameras[(index + 1) % cameras.length];
    await this.start({ deviceId: next.deviceId });
  }
}
