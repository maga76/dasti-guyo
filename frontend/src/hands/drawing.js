// Рисует руки поверх видео: полупрозрачная ладонь, пальцы — плавные линии, которые
// сужаются к кончикам, точки — только на кончиках пальцев.
// Для рисования точки сглаживаются фильтром One Euro: дрожание камеры убирается, а при быстром
// движении сглаживание почти выключается — рисунок не отстаёт от руки. Распознавание получает
// исходные, несглаженные точки.
// Холст отзеркален через CSS вместе с видео, поэтому точки рисуем
// в исходных координатах, а текст дополнительно переворачиваем, чтобы он читался.

// Как соединены 21 точка руки MediaPipe: 0 — запястье, 4/8/12/16/20 — кончики пальцев
export const CONNECTIONS = [
  // ладонь
  [0, 1], [0, 5], [0, 17], [5, 9], [9, 13], [13, 17],
  // большой
  [1, 2], [2, 3], [3, 4],
  // указательный
  [5, 6], [6, 7], [7, 8],
  // средний
  [9, 10], [10, 11], [11, 12],
  // безымянный
  [13, 14], [14, 15], [15, 16],
  // мизинец
  [17, 18], [18, 19], [19, 20],
];
const FINGERTIPS = new Set([4, 8, 12, 16, 20]);

// Цвета видны и на светлом, и на тёмном фоне видео
const HAND_COLORS = {
  right: '#F2B233',
  left: '#5EC8E5',
};

// Пальцы — цепочки от основания к кончику (большой — от запястья)
const FINGER_CHAINS = [
  [0, 1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
// Контур ладони
const PALM = [0, 1, 5, 9, 13, 17];

/**
 * Фильтр One Euro (Casiez и др., 2012) для одной координаты: чем медленнее движение,
 * тем сильнее сглаживание; при быстром — почти без задержки.
 * Координаты — доли кадра (0…1), время — в секундах.
 */
class OneEuro {
  constructor(minCutoff = 1.5, beta = 4, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: 0 });
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value, t) {
    if (this.x === null) {
      this.x = value;
      this.t = t;
      return value;
    }
    const dt = Math.max(t - this.t, 1e-3);
    this.t = t;
    const dx = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

// Фильтры по руке: левая/правая × 21 точка × (x, y). Рука пропала — фильтры сбрасываются.
const smoothers = { left: null, right: null };

function smoothPoints(hand, t) {
  smoothers[hand.side] ??= hand.landmarks.map(() => [new OneEuro(), new OneEuro()]);
  const f = smoothers[hand.side];
  return hand.landmarks.map((p, i) => [f[i][0].filter(p.x, t), f[i][1].filter(p.y, t)]);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./handTracker.js').Hand[]} hands
 * @param {{mirrored: boolean, labels: {left: string, right: string}}} opts
 */
export function drawHands(ctx, hands, { mirrored, labels }) {
  const { width: w, height: h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  const t = performance.now() / 1000;
  for (const side of ['left', 'right']) {
    if (!hands.some((hand) => hand.side === side)) smoothers[side] = null;
  }
  if (!hands.length) return;

  const unit = Math.max(1.5, w / 320);

  for (const hand of hands) {
    const color = HAND_COLORS[hand.side];
    const pts = smoothPoints(hand, t).map(([x, y]) => [x * w, y * h]);
    // Толщина — от размера руки в кадре: дальняя рука тоньше, ближняя толще
    const palm = Math.hypot(pts[9][0] - pts[0][0], pts[9][1] - pts[0][1]);
    const thick = Math.min(Math.max(palm * 0.09, unit * 1.6), unit * 5);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Ладонь: полупрозрачная заливка и тонкий контур
    ctx.beginPath();
    PALM.forEach((i, k) => (k ? ctx.lineTo(...pts[i]) : ctx.moveTo(...pts[i])));
    ctx.closePath();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = thick * 0.45;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Пальцы: подложка — одной линией на весь палец (без «бугров» на суставах): широкий
    // полупрозрачный ореол цвета руки и тёмная кайма, сверху цветные фаланги, к кончику тоньше.
    // Ореол — обычной линией, а не shadowBlur: размытие тени браузер считает на каждом кадре заново,
    // и на слабых телефонах из-за него подтормаживало видео
    for (const chain of FINGER_CHAINS) {
      ctx.beginPath();
      chain.forEach((i, k) => (k ? ctx.lineTo(...pts[i]) : ctx.moveTo(...pts[i])));
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = color;
      ctx.lineWidth = thick * 2.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = thick + unit;
      ctx.stroke();
      ctx.strokeStyle = color;
      for (let k = 1; k < chain.length; k++) {
        ctx.beginPath();
        ctx.moveTo(...pts[chain[k - 1]]);
        ctx.lineTo(...pts[chain[k]]);
        ctx.lineWidth = thick * (1 - (k - 1) * 0.16);
        ctx.stroke();
      }
    }

    // Кончики пальцев — единственные точки
    for (const i of FINGERTIPS) {
      const [x, y] = pts[i];
      ctx.beginPath();
      ctx.arc(x, y, thick * 0.75, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = thick * 0.35;
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    drawLabel(ctx, labels[hand.side], pts[0], color, unit, mirrored);
  }
}

/** Подпись «Дасти рост / Дасти чап» под запястьем. */
function drawLabel(ctx, text, [x, y], color, unit, mirrored) {
  const { width: w, height: h } = ctx.canvas;
  const fontSize = Math.round(unit * 7);
  ctx.save();
  if (mirrored) {
    // Отменяем CSS-зеркало только для текста
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    x = w - x;
  }
  ctx.font = `600 ${fontSize}px "Noto Sans", system-ui, sans-serif`;
  const padX = fontSize * 0.5;
  const boxW = ctx.measureText(text).width + padX * 2;
  const boxH = fontSize * 1.6;
  const bx = Math.min(Math.max(x - boxW / 2, 4), w - boxW - 4);
  const by = Math.min(y + fontSize, h - boxH - 4);

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(bx, by, boxW, boxH, boxH / 2);
  ctx.fill();
  ctx.fillStyle = '#0B1410';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + padX, by + boxH / 2 + 1);
  ctx.restore();
}

export function clearCanvas(ctx) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  smoothers.left = smoothers.right = null;
}

/**
 * Миниатюра позы из сохранённого кадра (126 нормализованных чисел).
 * Рисуется зеркально, как на экране: левая рука — слева, правая — справа.
 * Нужна, чтобы быстро найти и удалить неудачный пример.
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} frame
 */
export function drawPoseThumb(canvas, frame) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);

  const hands = ['left', 'right']
    .map((side, i) => ({ side, values: frame.slice(i * 63, i * 63 + 63) }))
    .filter((hand) => hand.values.some((v) => v !== 0));
  if (!hands.length) {
    // «Нет жеста» без рук — просто прочерк
    ctx.strokeStyle = '#8a978f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w * 0.35, h / 2);
    ctx.lineTo(w * 0.65, h / 2);
    ctx.stroke();
    return;
  }

  const slotW = w / hands.length;
  hands.forEach((hand, slot) => {
    // Точки относительно запястья; x отражаем, как в зеркальном видео
    const pts = [];
    for (let i = 0; i < 21; i++) pts.push([-hand.values[i * 3], hand.values[i * 3 + 1]]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const size = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
    const pad = 6;
    const scale = (Math.min(slotW, h) - pad * 2) / size;
    const ox = slot * slotW + (slotW - (Math.max(...xs) - minX) * scale) / 2;
    const oy = (h - (Math.max(...ys) - minY) * scale) / 2;
    const map = ([x, y]) => [ox + (x - minX) * scale, oy + (y - minY) * scale];

    ctx.strokeStyle = HAND_COLORS[hand.side];
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      const [ax, ay] = map(pts[a]);
      const [bx, by] = map(pts[b]);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
  });
}
