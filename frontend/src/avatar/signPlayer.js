// Проигрыватель жестов для аватара: записи движений рук (набор Slovo) → позы по времени.
//
// Запись хранит для каждого кадра форму руки, положение запястья в кадре и размер ладони
// (см. dataset/features.js). Переводим это в мировые координаты аватара:
//   - масштаб — по размеру ладони: ладонь на записи = ладонь аватара;
//   - центр кадра — верх груди аватара; глубина — чуть впереди тела.
// Главная рука записи (слот 0) — правая рука аватара, вторая — левая.

import * as THREE from 'three';
import { INPUT_SIZE, POINTS, SLOT, sequenceFeatures } from '../dataset/features.js';

const CLIP_SECONDS = 2.0; // длительность одного жеста при скорости 1× (медленнее, чем в жизни, — чтобы было понятно)
const GAP_SECONDS = 0.25; // пауза между словами
const FADE_SECONDS = 0.35; // вход в жест из спокойной позы и выход
const MAX_HOLD_FRAMES = 4; // сколько кадров «держать» руку, если на записи она пропала

/**
 * Выбрать для каждого жеста самую типичную запись (ближе всех к остальным — «медоид»)
 * среди тех, где руки видны почти всё время.
 * @param {{label: string, train: boolean, frames: Float32Array[]}[]} samples
 * @returns {Map<string, Float32Array[]>}
 */
export function pickRepresentatives(samples) {
  const byLabel = new Map();
  for (const s of samples) {
    const visible = s.frames.filter((f) => f[65] > 0).length / s.frames.length;
    if (visible < 0.8) continue;
    if (!byLabel.has(s.label)) byLabel.set(s.label, []);
    byLabel.get(s.label).push(s);
  }
  const result = new Map();
  for (const [label, list] of byLabel) {
    const vectors = list.map((s) => sequenceFeatures(s.frames));
    let best = 0;
    let bestScore = Infinity;
    vectors.forEach((a, i) => {
      let score = 0;
      for (const b of vectors) for (let k = 0; k < INPUT_SIZE; k++) score += (a[k] - b[k]) ** 2;
      if (score < bestScore) [best, bestScore] = [i, score];
    });
    result.set(label, list[best].frames);
  }
  return result;
}

/**
 * Кадры записи → точки рук в мировых координатах аватара.
 * @returns {{Right: (THREE.Vector3[]|null)[], Left: (THREE.Vector3[]|null)[]}}
 */
export function framesToWorld(frames, rig) {
  let palmSum = 0;
  let palmCount = 0;
  for (const f of frames) {
    for (const base of [0, SLOT]) {
      if (f[base + 65] > 0) {
        palmSum += f[base + 65];
        palmCount++;
      }
    }
  }
  const palmMean = palmCount ? palmSum / palmCount : 0.06;
  const scale = rig.sides.Right.palmLen / palmMean; // метров на «долю высоты кадра»
  const chest = rig.chest;

  // Часть видео снята фронтальной камерой и отзеркалена (или человек левша): тогда
  // главная рука справа в кадре. Разворачиваем такую запись — аватар всегда жестикулирует
  // как правша, а сам жест остаётся тем же (зеркальным отражением).
  const meanX = (base) => {
    let sum = 0;
    let n = 0;
    for (const f of frames) if (f[base + 65] > 0) (sum += f[base + 63]), n++;
    return n ? sum / n : null;
  };
  const flip = (meanX(0) ?? 0) > 0 ? -1 : 1;
  // Какая рука записи какой руке аватара: левее в кадре — правая рука аватара
  const x0 = (meanX(0) ?? 0) * flip;
  const x1 = meanX(SLOT);
  const slot0Side = x1 === null ? 'Right' : x0 <= x1 * flip ? 'Right' : 'Left';
  const slots = [
    [slot0Side, 0],
    [slot0Side === 'Right' ? 'Left' : 'Right', SLOT],
  ];

  const track = { Right: [], Left: [] };
  for (const f of frames) {
    slots.forEach(([side, base]) => {
      const palm = f[base + 65];
      if (!(palm > 0)) {
        track[side].push(null);
        return;
      }
      // Ближе к камере — ладонь крупнее: используем это как подсказку глубины
      const depth = 0.24 + THREE.MathUtils.clamp(palm / palmMean - 1, -0.5, 0.5) * 0.3;
      const wrist = new THREE.Vector3(chest.x + flip * f[base + 63] * scale, chest.y - f[base + 64] * scale, chest.z + depth);
      const k = palm * scale;
      const points = [];
      for (let i = 0; i < POINTS; i++) {
        points.push(
          new THREE.Vector3(
            wrist.x + flip * f[base + i * 3] * k,
            wrist.y - f[base + i * 3 + 1] * k,
            wrist.z - f[base + i * 3 + 2] * k,
          ),
        );
      }
      track[side].push(points);
    });
  }
  // Сглаживание по времени (среднее по 3 соседним кадрам): убирает дрожание точек с видео
  for (const side of ['Right', 'Left']) {
    const src = track[side];
    track[side] = src.map((p, i) => {
      if (!p) return null;
      const near = [src[i - 1], p, src[i + 1]].filter(Boolean);
      return p.map((_, k) => near.reduce((acc, q) => acc.add(q[k]), new THREE.Vector3()).divideScalar(near.length));
    });
  }
  // Короткие пропуски руки заполняем последней известной позой
  for (const side of ['Right', 'Left']) {
    let last = null;
    let held = 0;
    track[side] = track[side].map((p) => {
      if (p) {
        last = p;
        held = 0;
        return p;
      }
      if (last && held++ < MAX_HOLD_FRAMES) return last;
      return null;
    });
  }
  return track;
}

function lerpPoints(a, b, t) {
  if (!a || !b) return a ?? b;
  return a.map((p, i) => p.clone().lerp(b[i], t));
}

export class SignPlayer {
  /** @param {import('./rig.js').AvatarRig} rig */
  constructor(rig) {
    this.rig = rig;
    this.queue = [];
    this.time = 0;
    this.playing = false;
    this.speed = 1;
    this.handlers = {};
  }

  /**
   * @param {{label: string, frames: Float32Array[]}[]} items жесты по порядку
   * @param {{onWord?: (i: number) => void, onEnd?: () => void}} handlers
   */
  play(items, handlers = {}) {
    const fade = FADE_SECONDS;
    let t = fade;
    this.queue = items.map((item, i) => {
      const duration = CLIP_SECONDS / this.speed;
      const clip = { ...item, index: i, start: t, duration, track: framesToWorld(item.frames, this.rig) };
      t += duration + GAP_SECONDS / this.speed;
      return clip;
    });
    this.total = t + fade;
    this.time = 0;
    this.current = -1;
    this.handlers = handlers;
    this.playing = this.queue.length > 0;
    if (!this.playing) handlers.onEnd?.();
  }

  stop() {
    this.playing = false;
    this.queue = [];
  }

  /**
   * Продвинуть время и вернуть позу рук.
   * @returns {{Right: THREE.Vector3[]|null, Left: THREE.Vector3[]|null, signing: boolean}}
   */
  update(dt) {
    if (!this.playing) return { Right: null, Left: null, signing: false };
    this.time += dt;

    // Какой жест сейчас (или ближайший — в паузах держим конец предыдущего)
    let clip = null;
    for (const c of this.queue) if (this.time >= c.start - 0.05) clip = c;
    if (clip && clip.index !== this.current) {
      this.current = clip.index;
      this.handlers.onWord?.(clip.index);
    }
    if (this.time >= this.total) {
      this.playing = false;
      this.handlers.onEnd?.();
      return { Right: null, Left: null, signing: false };
    }
    if (!clip) return { Right: null, Left: null, signing: true };

    const local = THREE.MathUtils.clamp((this.time - clip.start) / clip.duration, 0, 1);
    const pose = { signing: true };
    for (const side of ['Right', 'Left']) {
      const frames = clip.track[side];
      const pos = local * (frames.length - 1);
      const i = Math.floor(pos);
      pose[side] = lerpPoints(frames[i], frames[Math.min(i + 1, frames.length - 1)], pos - i);
    }
    // После последнего жеста руки возвращаются в спокойную позу (плавность даёт сглаживание в rig)
    if (this.time > this.total - FADE_SECONDS) return { Right: null, Left: null, signing: true };
    return pose;
  }
}
