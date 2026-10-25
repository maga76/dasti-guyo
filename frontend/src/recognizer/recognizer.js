// Распознавание в реальном времени.
// Хранит кадры за последние 2.5 с и ~7 раз в секунду спрашивает модель:
// «что за жест в последних 1 / 1.5 / 2 секундах?» — жесты бывают быстрые и медленные.
// Из трёх ответов берётся самый уверенный.

import { SLOT, frameFromHands, hasHands } from '../dataset/features.js';
import { NONE_LABEL } from '../dataset/dataset.js';

const KEEP_MS = 2500;
const WINDOWS_MS = [1000, 1500, 2000];
const MIN_FRAMES = 8; // меньше — не о чем судить
const EVERY_MS = 150;
// Руки почти стоят — это не жест (просто держат руки в кадре). Скорость — в ладонях в секунду.
// Порог из записей Slovo: в 99% настоящих жестов руки движутся быстрее 1.4 ладони/с,
// а неподвижная рука в камере лишь чуть дрожит. Без этого модель называла неподвижные
// руки самым похожим жестом («Дард мекунад» — руки у груди).
export const MIN_MOTION = 0.9;
const MOTION_POINTS = [0, 4, 8, 12, 16, 20]; // запястье и кончики пальцев

/** Средняя скорость рук в окне: сдвиг запястья и кончиков пальцев, в ладонях за секунду. */
export function motionSpeed(items) {
  let path = 0;
  for (let k = 1; k < items.length; k++) {
    const a = items[k - 1].frame;
    const b = items[k].frame;
    for (const base of [0, SLOT]) {
      const size = (a[base + 65] + b[base + 65]) / 2;
      if (!(a[base + 65] > 0 && b[base + 65] > 0)) continue;
      let step = 0;
      for (const i of MOTION_POINTS) {
        // Точка в кадре = запястье + форма × размер ладони
        const ax = a[base + 63] + a[base + i * 3] * a[base + 65];
        const ay = a[base + 64] + a[base + i * 3 + 1] * a[base + 65];
        const bx = b[base + 63] + b[base + i * 3] * b[base + 65];
        const by = b[base + 64] + b[base + i * 3 + 1] * b[base + 65];
        step += Math.hypot(bx - ax, by - ay);
      }
      path += step / MOTION_POINTS.length / size;
    }
  }
  const seconds = (items.at(-1).t - items[0].t) / 1000;
  return seconds > 0 ? path / seconds : 0;
}

export class LiveRecognizer {
  /**
   * @param {object} deps
   * @param {import('../model/classifier.js').GestureClassifier} deps.classifier
   * @param {() => number} deps.getAspect
   */
  constructor({ classifier, getAspect }) {
    this.classifier = classifier;
    this.getAspect = getAspect;
    this.buffer = []; // {t, frame}
    this.lastRun = 0;
    this.listeners = new Set();
    this.paused = false;
  }

  /** Подписка на результаты: fn({label, confidence, hands}) */
  onPrediction(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  reset() {
    this.buffer = [];
  }

  /** Вызывается на каждом кадре с руками от MediaPipe. */
  push(hands, now = performance.now()) {
    this.buffer.push({ t: now, frame: frameFromHands(hands, this.getAspect()) });
    while (this.buffer.length && now - this.buffer[0].t > KEEP_MS) this.buffer.shift();
    if (!this.paused && this.classifier.isReady && now - this.lastRun >= EVERY_MS) {
      this.lastRun = now;
      const result = this.predict(now);
      this.listeners.forEach((fn) => fn(result));
    }
  }

  predict(now) {
    let best = { label: NONE_LABEL, confidence: 0 };
    let handsSeen = false;
    for (const win of WINDOWS_MS) {
      const items = this.buffer.filter((item) => now - item.t <= win);
      const frames = items.map((item) => item.frame);
      if (frames.length < MIN_FRAMES) continue;
      // Если рук почти не было — это точно «нет жеста», модель не спрашиваем
      const withHands = frames.filter(hasHands).length;
      if (withHands < frames.length * 0.5) continue;
      handsSeen = true;
      // Руки стоят — тоже не жест
      if (motionSpeed(items) < MIN_MOTION) continue;
      const p = this.classifier.predict(frames);
      if (p.confidence > best.confidence) best = p;
    }
    return { label: best.label, confidence: best.confidence, hands: handsSeen };
  }
}
