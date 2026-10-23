// Рисует точки и линии рук поверх видео.
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

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./handTracker.js').Hand[]} hands
 * @param {{mirrored: boolean, labels: {left: string, right: string}}} opts
 */
export function drawHands(ctx, hands, { mirrored, labels }) {
  const { width: w, height: h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  if (!hands.length) return;

  const unit = Math.max(1.5, w / 320);

  for (const hand of hands) {
    const color = HAND_COLORS[hand.side];
    const pts = hand.landmarks.map((p) => [p.x * w, p.y * h]);

    // Линии: тёмная подложка + цветная линия — видно на любом фоне
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [stroke, width] of [['rgba(0,0,0,0.55)', unit * 2.4], [color, unit * 1.3]]) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const [a, b] of CONNECTIONS) {
        ctx.moveTo(pts[a][0], pts[a][1]);
        ctx.lineTo(pts[b][0], pts[b][1]);
      }
      ctx.stroke();
    }

    // Точки
    pts.forEach(([x, y], i) => {
      const r = FINGERTIPS.has(i) ? unit * 2.6 : unit * 1.8;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = unit * 0.9;
      ctx.strokeStyle = color;
      ctx.stroke();
    });

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
