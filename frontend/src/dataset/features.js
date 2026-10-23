// Признаки для модели распознавания жестов (версия 2: модель видит движение).
//
// ЭТОТ ФАЙЛ ДОЛЖЕН СОВПАДАТЬ С backend/app/services/features.py — браузер и сервер
// обязаны считать одинаково. Совпадение проверяет tests/selftest.html.
//
// Кадр — 132 числа: два «слота» рук по 66 чисел.
//   слот 0 — главная рука, слот 1 — вторая. Если рук две, главная — та, что ЛЕВЕЕ
//   в исходном (не отзеркаленном) кадре: у человека лицом к камере это его правая рука.
//   Внутри слота:
//     [0..62]  форма руки: 21 точка (x, y, z) относительно запястья, делённые на размер ладони
//     [63, 64] положение запястья относительно центра кадра (в долях высоты кадра)
//     [65]     размер ладони (в долях высоты кадра); 0 — руки нет
//
// Последовательность (вход модели): запись любой длины → 16 кадров → положение и масштаб
// считаются относительно главной руки → 16 × 132 = 2112 чисел.

export const POINTS = 21;
export const SLOT = POINTS * 3 + 3; // 66
export const FRAME = SLOT * 2; // 132
export const SEQ_LEN = 16;
export const INPUT_SIZE = SEQ_LEN * FRAME; // 2112
export const FEATURE_VERSION = 2;

const LIMIT = 10;
const clamp = (v) => Math.max(-LIMIT, Math.min(LIMIT, v));

/**
 * Руки одного кадра → 132 числа.
 * @param {{landmarks: {x:number, y:number, z:number}[]}[]} hands
 * @param {number} aspect ширина / высота кадра
 * @returns {number[]}
 */
export function frameFromHands(hands, aspect) {
  const out = new Array(FRAME).fill(0);
  const ordered = hands
    .slice(0, 2)
    .map((h) => h.landmarks)
    .sort((a, b) => a[0].x - b[0].x); // главная рука — левее в кадре

  ordered.forEach((pts, slot) => {
    const base = slot * SLOT;
    const w = pts[0];
    const m = pts[9];
    const palm = Math.hypot((m.x - w.x) * aspect, m.y - w.y, (m.z - w.z) * aspect) || 1e-6;
    for (let i = 0; i < POINTS; i++) {
      const p = pts[i];
      out[base + i * 3] = clamp(((p.x - w.x) * aspect) / palm);
      out[base + i * 3 + 1] = clamp((p.y - w.y) / palm);
      out[base + i * 3 + 2] = clamp(((p.z - w.z) * aspect) / palm);
    }
    out[base + 63] = clamp((w.x - 0.5) * aspect);
    out[base + 64] = clamp(w.y - 0.5);
    out[base + 65] = clamp(palm);
  });
  return out;
}

/** Запись любой длины → ровно `length` кадров (ближайший кадр, без смешивания). */
export function resample(frames, length = SEQ_LEN) {
  const n = frames.length;
  if (n === 1) return Array.from({ length }, () => frames[0]);
  return Array.from({ length }, (_, i) => frames[Math.floor((i * (n - 1)) / (length - 1) + 0.5)]);
}

/**
 * Кадры записи → вход модели (2112 чисел).
 * @param {ArrayLike<number>[]} frames
 * @param {Float32Array} [out] куда записать (чтобы не создавать лишних массивов)
 */
export function sequenceFeatures(frames, out = new Float32Array(INPUT_SIZE)) {
  const seq = resample(frames);

  // Опорная точка и масштаб — средние положение и размер главной руки
  let refX = 0;
  let refY = 0;
  let scale = 0;
  let count = 0;
  for (const f of seq) {
    if (f[65] > 0) {
      refX += f[63];
      refY += f[64];
      scale += f[65];
      count++;
    }
  }
  if (count) {
    refX /= count;
    refY /= count;
    scale /= count;
  } else {
    scale = 1;
  }
  scale ||= 1;

  seq.forEach((f, t) => {
    const o = t * FRAME;
    for (let k = 0; k < FRAME; k++) out[o + k] = f[k];
    for (const base of [0, SLOT]) {
      if (f[base + 65] > 0) {
        out[o + base + 63] = (f[base + 63] - refX) / scale;
        out[o + base + 64] = (f[base + 64] - refY) / scale;
        out[o + base + 65] = f[base + 65] / scale;
      }
    }
    for (let k = 0; k < FRAME; k++) out[o + k] = clamp(out[o + k]);
  });
  return out;
}

/** Зеркальное отражение записи (как будто жест показывает левша). */
export function mirror(frames) {
  return frames.map((f) => {
    const out = Array.from(f);
    for (const base of [0, SLOT]) {
      for (let i = 0; i < POINTS; i++) out[base + i * 3] = -out[base + i * 3] || 0;
      out[base + 63] = -out[base + 63] || 0;
    }
    // После отражения главная рука оказывается правее — меняем слоты местами
    if (out[65] > 0 && out[SLOT + 65] > 0) return [...out.slice(SLOT), ...out.slice(0, SLOT)];
    return out;
  });
}

/** Нормальное распределение (метод Бокса — Мюллера). */
function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

/** Случайно изменённая копия записи: обрезка по времени, зеркало, шум. */
export function augment(frames) {
  let arr = frames;
  const n = arr.length;
  if (n >= 8) {
    const cut = Math.max(1, Math.floor(n * 0.15));
    const start = Math.floor(Math.random() * (cut + 1));
    const end = n - Math.floor(Math.random() * (cut + 1));
    arr = arr.slice(start, Math.max(end, start + 4));
  }
  arr = Math.random() < 0.5 ? mirror(arr) : arr.map((f) => Array.from(f));
  for (const f of arr) {
    for (const base of [0, SLOT]) {
      if (!(f[base + 65] > 0)) continue; // отсутствующая рука остаётся нулями
      for (let k = 0; k < 63; k++) f[base + k] += gauss() * 0.03;
      f[base + 63] += gauss() * 0.01;
      f[base + 64] += gauss() * 0.01;
    }
  }
  return arr;
}

/** Есть ли в кадре хоть одна рука. */
export const hasHands = (frame) => frame[65] > 0;
