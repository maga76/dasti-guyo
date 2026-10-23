// Запись одного примера жеста: обратный отсчёт 3 с → сбор N кадров точек рук.

import { frameFromHands } from './features.js';

export class RecordError extends Error {
  /** @param {'noHands'|'cancelled'} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const COUNTDOWN_SECONDS = 3;
// Если за это время не набралось кадров с руками — запись не удалась
const MAX_RECORD_MS = 12_000;
// Меньше этого — запись бракуется (на сервере минимум 10)
const MIN_FRAMES = 20;

export class Recorder {
  /** @param {() => number} getAspect ширина/высота кадра */
  constructor(getAspect) {
    this.getAspect = getAspect;
    this.active = null; // текущая запись
  }

  get isBusy() {
    return Boolean(this.active);
  }

  /** Вызывается на каждом результате распознавания рук. */
  feed(hands) {
    const rec = this.active;
    if (!rec || rec.phase !== 'recording') return;
    // Для обычного жеста кадры без рук бесполезны; для «нет жеста» — нужны
    if (!hands.length && !rec.isNone) return;

    rec.frames.push(frameFromHands(hands, this.getAspect()));
    rec.maxHands = Math.max(rec.maxHands, hands.length);
    rec.onProgress?.(rec.frames.length, rec.target);
    if (rec.frames.length >= rec.target) rec.finish();
  }

  /**
   * @param {object} opts
   * @param {number} opts.target сколько кадров записать (50–100)
   * @param {boolean} [opts.isNone] запись класса «нет жеста»
   * @param {(secondsLeft: number) => void} [opts.onCountdown]
   * @param {(collected: number, total: number) => void} [opts.onProgress]
   * @returns {Promise<{frames: number[][], handCount: number}>}
   */
  record({ target, isNone = false, onCountdown, onProgress }) {
    if (this.active) return Promise.reject(new Error('busy'));

    return new Promise((resolve, reject) => {
      const rec = {
        phase: 'countdown',
        target,
        isNone,
        frames: [],
        maxHands: 0,
        onProgress,
        timers: [],
      };
      const cleanup = () => {
        rec.timers.forEach(clearTimeout);
        this.active = null;
      };
      rec.finish = () => {
        cleanup();
        if (rec.frames.length < MIN_FRAMES) {
          reject(new RecordError('noHands'));
          return;
        }
        // Сервер ждёт 1 или 2 руки; у «нет жеста» рук может не быть совсем
        resolve({ frames: rec.frames, handCount: Math.max(1, Math.min(2, rec.maxHands)) });
      };
      rec.cancel = () => {
        cleanup();
        reject(new RecordError('cancelled'));
      };
      this.active = rec;

      // Обратный отсчёт: 3, 2, 1
      for (let i = 0; i < COUNTDOWN_SECONDS; i++) {
        rec.timers.push(setTimeout(() => onCountdown?.(COUNTDOWN_SECONDS - i), i * 1000));
      }
      rec.timers.push(
        setTimeout(() => {
          rec.phase = 'recording';
          onCountdown?.(0);
          onProgress?.(0, target);
          rec.timers.push(setTimeout(() => rec.finish(), MAX_RECORD_MS));
        }, COUNTDOWN_SECONDS * 1000),
      );
    });
  }

  cancel() {
    this.active?.cancel();
  }
}
