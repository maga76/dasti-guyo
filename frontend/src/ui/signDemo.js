// «Чӣ тавр нишон додан?» — анимация жеста по записи из набора Slovo.
// Показываем точки и линии рук, как будто человек стоит напротив вас,
// и бледный след запястья, чтобы было видно движение.

import { CONNECTIONS } from '../hands/drawing.js';
import { POINTS, SLOT } from '../dataset/features.js';
import { loadBaseDataset } from '../dataset/baseDataset.js';

const COLORS = ['#F2B233', '#5EC8E5']; // главная рука, вторая рука
const FRAME_MS = 50; // 32 кадра ≈ 1.6 с
const PAUSE_MS = 700;

export class SignDemo {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.timer = 0;
    this.variant = new Map(); // какой пример показывать следующим для каждого слова
  }

  /** Есть ли пример для этого слова. */
  async has(label) {
    const base = await loadBaseDataset();
    return Boolean(base?.samples.some((s) => s.label === label));
  }

  async play(label) {
    this.stop();
    const base = await loadBaseDataset();
    const examples = base?.samples.filter((s) => s.label === label) ?? [];
    if (!examples.length) return false;
    // Каждое нажатие — другой человек: так видно, что жест можно показать по-разному
    const i = (this.variant.get(label) ?? -1) + 1;
    this.variant.set(label, i);
    const frames = examples[i % examples.length].frames;

    const scene = toScene(frames);
    let f = 0;
    const tick = () => {
      this.draw(scene, f);
      f = (f + 1) % frames.length;
      this.timer = setTimeout(tick, f === 0 ? PAUSE_MS : FRAME_MS);
    };
    tick();
    return true;
  }

  stop() {
    clearTimeout(this.timer);
  }

  draw(scene, f) {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Вписываем всё движение в холст
    const pad = 24;
    const scale = Math.min((w - pad * 2) / scene.width, (h - pad * 2) / scene.height);
    const ox = (w - scene.width * scale) / 2 - scene.minX * scale;
    const oy = (h - scene.height * scale) / 2 - scene.minY * scale;
    const map = ([x, y]) => [ox + x * scale, oy + y * scale];

    // След запястья за весь жест
    scene.trails.forEach((trail, slot) => {
      ctx.strokeStyle = COLORS[slot];
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 3;
      ctx.beginPath();
      trail.forEach((p, i) => {
        if (!p) return;
        const [x, y] = map(p);
        if (i === 0 || !trail[i - 1]) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    // Руки в текущем кадре
    scene.hands[f].forEach((pts, slot) => {
      if (!pts) return;
      const px = pts.map(map);
      ctx.strokeStyle = COLORS[slot];
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const [a, b] of CONNECTIONS) {
        ctx.moveTo(px[a][0], px[a][1]);
        ctx.lineTo(px[b][0], px[b][1]);
      }
      ctx.stroke();
      ctx.fillStyle = '#fff';
      for (const [x, y] of px) {
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
}

/** Кадры (132 числа) → координаты точек рук в долях высоты кадра. */
function toScene(frames) {
  const hands = frames.map((frame) =>
    [0, SLOT].map((base) => {
      const palm = frame[base + 65];
      if (!(palm > 0)) return null;
      const wx = frame[base + 63];
      const wy = frame[base + 64];
      return Array.from({ length: POINTS }, (_, i) => [
        wx + frame[base + i * 3] * palm,
        wy + frame[base + i * 3 + 1] * palm,
      ]);
    }),
  );
  const trails = [0, 1].map((slot) => hands.map((h) => h[slot]?.[0] ?? null));
  const all = hands.flat().filter(Boolean).flat();
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    hands,
    trails,
    minX,
    minY,
    width: Math.max(...xs) - minX || 1,
    height: Math.max(...ys) - minY || 1,
  };
}
