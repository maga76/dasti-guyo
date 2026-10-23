// «Шакли даст» — крупный план кистей рядом с аватаром.
// Каждая рука рисуется отдельно и крупно (по точкам из записи), чтобы форма кисти —
// какие пальцы согнуты, какие вытянуты — читалась сразу, даже если на 3D-модели
// один палец закрыт другим. Где рука в пространстве — видно на самом аватаре.

import { CONNECTIONS } from '../hands/drawing.js';

const COLORS = { Right: '#F2B233', Left: '#5EC8E5' };
const FINGERTIPS = new Set([4, 8, 12, 16, 20]);

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{Right: import('three').Vector3[]|null, Left: import('three').Vector3[]|null}} pose
 */
export function drawHandInset(canvas, pose) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Правая рука аватара для зрителя слева — так же раскладываем и на схеме
  const hands = ['Right', 'Left'].filter((side) => pose?.[side]);
  if (!hands.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 3, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const slotW = w / hands.length;
  hands.forEach((side, slot) => {
    const pts = pose[side];
    // Масштаб по длине ладони (запястье → основание среднего пальца): кисть всегда одного размера
    // (длина в 3D — не «сжимается», когда кисть наклонена к зрителю)
    const palm = pts[9].distanceTo(pts[0]) || 0.08;
    const scale = (Math.min(slotW, h) * 0.4) / palm;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const map = (p) => [slot * slotW + slotW / 2 + (p.x - cx) * scale, h / 2 - (p.y - cy) * scale];
    const px = pts.map(map);

    ctx.strokeStyle = COLORS[side];
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      ctx.moveTo(px[a][0], px[a][1]);
      ctx.lineTo(px[b][0], px[b][1]);
    }
    ctx.stroke();
    px.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(x, y, FINGERTIPS.has(i) ? 4.5 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = FINGERTIPS.has(i) ? COLORS[side] : '#fff';
      ctx.fill();
    });
  });
}
