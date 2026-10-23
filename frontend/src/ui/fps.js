// Счётчик кадров в секунду по скользящему окну в 1 секунду.

export class FpsMeter {
  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
    this.times = [];
  }

  tick(now = performance.now()) {
    this.times.push(now);
    while (this.times.length && now - this.times[0] > this.windowMs) this.times.shift();
  }

  get fps() {
    // Если кадров давно не было — честно показываем 0
    const now = performance.now();
    while (this.times.length && now - this.times[0] > this.windowMs) this.times.shift();
    return this.times.length * (1000 / this.windowMs);
  }

  reset() {
    this.times = [];
  }
}
