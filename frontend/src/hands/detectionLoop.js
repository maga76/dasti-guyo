// Цикл распознавания: берёт новые кадры видео и передаёт их в HandTracker.
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
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
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
    this.rafId = requestAnimationFrame(this.tick);

    const video = this.video;
    // Нет данных или кадр не сменился с прошлого раза — ждём
    if (video.readyState < 2 || video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;
    this.videoFps.tick();

    this.frameIndex += 1;
    if (this.frameIndex % this.skip !== 0) return;

    const start = performance.now();
    let hands;
    try {
      hands = this.tracker.detect(video, start);
    } catch (err) {
      console.error('[hands] Ошибка распознавания:', err);
      return;
    }
    const spent = performance.now() - start;
    this.avgDetectMs = this.avgDetectMs ? this.avgDetectMs * 0.9 + spent * 0.1 : spent;
    this.detectFps.tick();
    this.adaptSkip(start);

    this.onHands(hands);
  }

  /** Раз в секунду подбирает, сколько кадров пропускать. */
  adaptSkip(now) {
    const { budgetMs, maxSkip, adaptEveryMs } = config.perf;
    if (now - this.lastAdaptAt < adaptEveryMs) return;
    this.lastAdaptAt = now;
    this.skip = Math.min(maxSkip, Math.max(1, Math.ceil(this.avgDetectMs / budgetMs)));
  }
}
