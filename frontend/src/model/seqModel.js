// Новая нейросеть распознавания (эксперимент): 1D-свёртки + Transformer по кадрам — как у решения,
// занявшего 1-е место в соревновании Google по жестовому языку на Kaggle (hoyso48, MIT).
// Обучается в backend/tools/train_seq_model.py (PyTorch); здесь — тот же расчёт на обычном
// JavaScript, без TF.js и видеокарты: сеть маленькая, а считается она в фоновом потоке (seqWorker.js).
//
// ПРИЗНАКИ (seqInput) И СЛОИ ДОЛЖНЫ СОВПАДАТЬ С train_seq_model.py — это проверяет самопроверка
// (check.json: те же записи → те же ответы, что у PyTorch).

const SLOT = 66;
const FRAME = SLOT * 2;
const LIMIT = 10;
const EPS = 1e-5;

/** Запись любой длины → ровно `length` кадров (ближайший кадр) — как resample() в features.py. */
function resample(frames, length) {
  const n = frames.length;
  return Array.from({ length }, (_, i) => frames[n === 1 ? 0 : Math.floor((i * (n - 1)) / (length - 1) + 0.5)]);
}

/**
 * Кадры записи (n × 132) → вход сети (seq × 264): нормализованные кадры и их скорость.
 * @param {ArrayLike<number>[]} frames
 * @param {number} seq
 */
export function seqInput(frames, seq) {
  const rows = resample(frames, seq).map((f) => Float32Array.from(f));
  let rx = 0;
  let ry = 0;
  let sc = 0;
  let count = 0;
  for (const r of rows) {
    if (r[65] > 0) {
      rx += r[63];
      ry += r[64];
      sc += r[65];
      count++;
    }
  }
  if (count) {
    rx /= count;
    ry /= count;
    sc /= count;
  } else {
    rx = 0;
    ry = 0;
    sc = 1;
  }
  sc ||= 1;
  for (const r of rows) {
    for (const b of [0, SLOT]) {
      if (!(r[b + 65] > 0)) continue;
      r[b + 63] = (r[b + 63] - rx) / sc;
      r[b + 64] = (r[b + 64] - ry) / sc;
      r[b + 65] = r[b + 65] / sc;
    }
    for (let i = 0; i < FRAME; i++) r[i] = Math.max(-LIMIT, Math.min(LIMIT, r[i]));
  }
  const out = new Float32Array(seq * FRAME * 2);
  for (let t = 0; t < seq; t++) {
    const r = rows[t];
    out.set(r, t * FRAME * 2);
    if (t === 0) continue;
    const p = rows[t - 1];
    for (const b of [0, SLOT]) {
      if (!(r[b + 65] > 0 && p[b + 65] > 0)) continue;
      for (let i = 0; i < SLOT; i++) out[t * FRAME * 2 + FRAME + b + i] = r[b + i] - p[b + i];
    }
  }
  return out;
}

// ---------- Слои ----------

/** y[T × out] = x[T × in] · W[in × out] + b */
function linear(x, T, din, { w, b }, dout) {
  const y = new Float32Array(T * dout);
  for (let t = 0; t < T; t++) {
    const yo = t * dout;
    y.set(b, yo);
    const xo = t * din;
    for (let i = 0; i < din; i++) {
      const v = x[xo + i];
      if (v === 0) continue;
      const wo = i * dout;
      for (let j = 0; j < dout; j++) y[yo + j] += v * w[wo + j];
    }
  }
  return y;
}

function layerNorm(x, T, d, { g, b }) {
  const y = new Float32Array(T * d);
  for (let t = 0; t < T; t++) {
    const o = t * d;
    let mean = 0;
    for (let i = 0; i < d; i++) mean += x[o + i];
    mean /= d;
    let v = 0;
    for (let i = 0; i < d; i++) v += (x[o + i] - mean) ** 2;
    const inv = 1 / Math.sqrt(v / d + EPS);
    for (let i = 0; i < d; i++) y[o + i] = (x[o + i] - mean) * inv * g[i] + b[i];
  }
  return y;
}

function silu(x) {
  for (let i = 0; i < x.length; i++) x[i] = x[i] / (1 + Math.exp(-x[i]));
  return x;
}

/** Свёртка по времени, у каждого канала своё ядро; края — нулями (padding «same»). */
function depthwise(x, T, C, { w, b }, K) {
  const y = new Float32Array(T * C);
  const pad = K >> 1;
  for (let t = 0; t < T; t++) {
    for (let c = 0; c < C; c++) {
      let s = b[c];
      for (let k = 0; k < K; k++) {
        const src = t + k - pad;
        if (src >= 0 && src < T) s += x[src * C + c] * w[c * K + k];
      }
      y[t * C + c] = s;
    }
  }
  return y;
}

function addInto(x, y) {
  for (let i = 0; i < x.length; i++) x[i] += y[i];
  return x;
}

function attention(qkv, T, D, heads) {
  const dh = D / heads;
  const scale = 1 / Math.sqrt(dh);
  const out = new Float32Array(T * D);
  const scores = new Float32Array(T);
  for (let h = 0; h < heads; h++) {
    const qo = h * dh;
    const ko = D + h * dh;
    const vo = 2 * D + h * dh;
    for (let t = 0; t < T; t++) {
      let max = -Infinity;
      for (let s = 0; s < T; s++) {
        let dot = 0;
        for (let i = 0; i < dh; i++) dot += qkv[t * 3 * D + qo + i] * qkv[s * 3 * D + ko + i];
        scores[s] = dot * scale;
        if (scores[s] > max) max = scores[s];
      }
      let sum = 0;
      for (let s = 0; s < T; s++) sum += scores[s] = Math.exp(scores[s] - max);
      for (let s = 0; s < T; s++) {
        const a = scores[s] / sum;
        for (let i = 0; i < dh; i++) out[t * D + h * dh + i] += a * qkv[s * 3 * D + vo + i];
      }
    }
  }
  return out;
}

export class SeqModel {
  /**
   * @param {object} meta model.json
   * @param {ArrayBuffer} weights weights.bin
   */
  constructor(meta, weights) {
    this.meta = meta;
    const all = new Float32Array(weights);
    this.t = {};
    for (const { name, shape, offset } of meta.tensors) {
      const size = shape.reduce((a, b) => a * b, 1);
      this.t[name] = all.subarray(offset, offset + size);
    }
  }

  get labels() {
    return this.meta.labels;
  }

  /** Вероятности слов для записи (кадры по 132 числа). */
  predict(frames) {
    const { seq: T, features, dim: D, heads, kernel, layers } = this.meta;
    const p = (name) => ({ w: this.t[`${name}.w`], b: this.t[`${name}.b`] });
    const n = (name) => ({ g: this.t[`${name}.g`], b: this.t[`${name}.b`] });
    let x = linear(seqInput(frames, T), T, features, p('stem'), D);
    layers.forEach((kind, i) => {
      const k = `b${i}.`;
      if (kind === 'conv') {
        let h = silu(linear(layerNorm(x, T, D, n(`${k}norm`)), T, D, p(`${k}expand`), 2 * D));
        h = silu(depthwise(h, T, 2 * D, p(`${k}dw`), kernel));
        x = addInto(x, linear(h, T, 2 * D, p(`${k}project`), D));
      } else {
        const qkv = linear(layerNorm(x, T, D, n(`${k}norm1`)), T, D, p(`${k}qkv`), 3 * D);
        x = addInto(x, linear(attention(qkv, T, D, heads), T, D, p(`${k}out`), D));
        const h = silu(linear(layerNorm(x, T, D, n(`${k}norm2`)), T, D, p(`${k}mlp1`), 2 * D));
        x = addInto(x, linear(h, T, 2 * D, p(`${k}mlp2`), D));
      }
    });
    const normed = layerNorm(x, T, D, n('norm'));
    const pooled = new Float32Array(D);
    for (let t = 0; t < T; t++) for (let i = 0; i < D; i++) pooled[i] += normed[t * D + i] / T;
    const logits = linear(pooled, 1, D, p('head'), this.labels.length);
    let max = -Infinity;
    for (const v of logits) if (v > max) max = v;
    let sum = 0;
    for (let i = 0; i < logits.length; i++) sum += logits[i] = Math.exp(logits[i] - max);
    for (let i = 0; i < logits.length; i++) logits[i] /= sum;
    return logits;
  }
}
