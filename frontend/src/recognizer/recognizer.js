// Распознавание в реальном времени.
// Хранит кадры за последние 2.5 с и ~7 раз в секунду спрашивает модель:
// «что за жест в последних 1 / 1.5 / 2 секундах?» — жесты бывают быстрые и медленные.
// Из трёх ответов берётся самый уверенный.

import { frameFromHands, hasHands } from '../dataset/features.js';
import { NONE_LABEL } from '../dataset/dataset.js';

const KEEP_MS = 2500;
const WINDOWS_MS = [1000, 1500, 2000];
const MIN_FRAMES = 8; // меньше — не о чем судить
const EVERY_MS = 150;

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
      const frames = [];
      for (const item of this.buffer) if (now - item.t <= win) frames.push(item.frame);
      if (frames.length < MIN_FRAMES) continue;
      // Если рук почти не было — это точно «нет жеста», модель не спрашиваем
      const withHands = frames.filter(hasHands).length;
      if (withHands < frames.length * 0.5) continue;
      handsSeen = true;
      const p = this.classifier.predict(frames);
      if (p.confidence > best.confidence) best = p;
    }
    return { label: best.label, confidence: best.confidence, hands: handsSeen };
  }
}
