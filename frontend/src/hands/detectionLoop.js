// Цикл распознавания: берёт новые кадры видео и передаёт их в HandTracker.
// Кадр берётся ровно в момент его появления (requestVideoFrameCallback), а не «на следующей
// перерисовке экрана»: меньше задержка и ни один кадр камеры не обрабатывается дважды.
// Если распознавание медленное — анализирует не каждый кадр (пропуск кадров),
// чтобы интерфейс не тормозил на слабых телефонах.

import { config } from '../config.js';
import { FpsMeter } from '../ui/fps.js';

export class DetectionLoop {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.video
   * @param {import('./handTracker.js').HandTracker} opts.tracker
   * @param {(hands: import('./handTracker.js').Hand[]) => void} opts.onHands
   */
  constructor({ video, tracker, onHands }) {
    this.video = video;
    this.tracker = tracker;
    this.onHands = onHands;

    this.running = false;
    this.rafId = 0;
    this.frameId = 0;
    this.byVideoFrame = typeof video.requestVideoFrameCallback === 'function';
    this.lastVideoTime = -1;
    this.frameIndex = 0;

    // Средняя длительность одного распознавания (экспоненциальное сглаживание)
    this.avgDetectMs = 0;
    // 1 = каждый кадр, 2 = каждый второй и т.д.
    this.skip = 1;
    this.lastAdaptAt = 0;

    this.videoFps = new FpsMeter();
    this.detectFps = new FpsMeter();

    this.tick = this.tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastVideoTime = -1;
    this.schedule();
  }

  schedule() {
    if (this.byVideoFrame) this.frameId = this.video.requestVideoFrameCallback(this.tick);
    else this.rafId = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    if (this.byVideoFrame) this.video.cancelVideoFrameCallback(this.frameId);
    this.videoFps.reset();
    this.detectFps.reset();
  }

  /** Текущие показатели для панели статистики. */
  get stats() {
    return {
      videoFps: this.videoFps.fps,
      detectFps: this.detectFps.fps,
      detectMs: this.avgDetectMs,
      skip: this.skip,
    };
  }

  tick() {
    if (!this.running) return;
    this.schedule();

    const video = this.video;
    // Нет данных или кадр не сменился с прошлого раза — ждём (с requestVideoFrameCallback
    // каждый вызов — уже новый кадр)
    if (video.readyState < 2) return;
    if (!this.byVideoFrame && video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;
    this.videoFps.tick();

    this.frameIndex += 1;
    // Прошлый кадр ещё распознаётся (в фоновом потоке) — этот пропускаем, очередь не копится
    if (this.busy || this.frameIndex % this.skip !== 0) return;

    const start = performance.now();
    this.busy = true;
    Promise.resolve()
      .then(() => this.tracker.detect(video, start))
      .then((hands) => {
        const spent = performance.now() - start;
        this.avgDetectMs = this.avgDetectMs ? this.avgDetectMs * 0.9 + spent * 0.1 : spent;
        this.detectFps.tick();
        // В фоновом потоке страница не ждёт распознавания — пропуск кадров не нужен
        if (!this.tracker.inWorker) this.adaptSkip(start);
        if (this.running) this.onHands(hands);
      })
      .catch((err) => console.error('[hands] Ошибка распознавания:', err))
      .finally(() => {
        this.busy = false;
      });
  }

  /** Раз в секунду подбирает, сколько кадров пропускать (только когда распознаём на странице). */
  adaptSkip(now) {
    const { budgetMs, maxSkip, adaptEveryMs } = config.perf;
    if (now - this.lastAdaptAt < adaptEveryMs) return;
    this.lastAdaptAt = now;
    this.skip = Math.min(maxSkip, Math.max(1, Math.ceil(this.avgDetectMs / budgetMs)));
  }
}
