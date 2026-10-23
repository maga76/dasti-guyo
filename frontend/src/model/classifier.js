// Наша нейросеть для распознавания жестов (TensorFlow.js).
//
// Вход — движение: 16 кадров × 132 числа = 2112 чисел (см. dataset/features.js).
// Устройство: 2112 → 256 → 128 → по одному выходу на каждый жест (softmax).
//
// Откуда берётся модель (по важности):
//   1) «своя» — пользователь обучил её в браузере (раздел «Омӯзиш»);
//   2) опубликованная на сервере администратором (скачивается и хранится для офлайна);
//   3) базовая, заранее обученная на наборе Slovo (public/models/base).

import { db } from '../dataset/db.js';
import { FEATURE_VERSION, INPUT_SIZE, augment, sequenceFeatures } from '../dataset/features.js';
import { MIN_SAMPLES, NONE_LABEL } from '../dataset/dataset.js';
import { loadBaseDataset, loadBaseMetrics } from '../dataset/baseDataset.js';

const MODEL_URL = 'indexeddb://dasti-guyo-local-model-v2';
const META_KEY = 'localModel';
const BASE_MODEL_URL = `${import.meta.env.BASE_URL}models/base/model.json`;
const SERVER_MODEL_URL = 'indexeddb://dasti-guyo-server-model';
const SERVER_META_KEY = 'serverModel';

// Сколько случайных копий делать из каждой записи при обучении
const COPIES_OWN = 8; // своих записей мало — копий больше
const COPIES_BASE = 2;
const EPOCHS = 25;

// TensorFlow.js большой (~1 МБ), поэтому грузим его только когда он нужен
let tfPromise = null;
export function loadTf() {
  tfPromise ??= import('@tensorflow/tfjs').then(async (tf) => {
    await tf.ready(); // сам выберет WebGL, а если его нет — CPU
    return tf;
  });
  return tfPromise;
}

export class TrainError extends Error {
  /** @param {'needTwo'|'needSamples'} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export class GestureClassifier {
  /** @param {{modelUrl?: string, metaKey?: string}} [storage] где хранить модель (тесты используют свои ключи) */
  constructor({ modelUrl = MODEL_URL, metaKey = META_KEY } = {}) {
    this.modelUrl = modelUrl;
    this.metaKey = metaKey;
    this.model = null;
    this.tf = null;
    /** {labels, accuracy, validated, source: 'local'|'base', trainedAt, confusion, curve, ...} */
    this.meta = null;
    this.loadAttempted = false;
    this.input = new Float32Array(INPUT_SIZE);
  }

  get isReady() {
    return Boolean(this.model);
  }

  /** Своя модель → модель с сервера (сохранённая) → базовая. */
  async load() {
    try {
      return (await this.loadLocal()) || (await this.loadServer()) || (await this.loadBase());
    } finally {
      this.loadAttempted = true; // чтобы экран не писал «модели нет», пока она ещё грузится
    }
  }

  async loadLocal() {
    const meta = await db.getMeta(this.metaKey);
    if (meta?.featureVersion !== FEATURE_VERSION) return false;
    const tf = await loadTf();
    try {
      this.setModel(tf, await tf.loadLayersModel(this.modelUrl), meta);
      return true;
    } catch (err) {
      console.warn('[model] Сохранённая модель не загрузилась:', err);
      return false;
    }
  }

  /** Модель, опубликованная на сервере и сохранённая в браузере при прошлом запуске. */
  async loadServer() {
    const meta = await db.getMeta(SERVER_META_KEY);
    if (meta?.featureVersion !== FEATURE_VERSION) return false;
    const tf = await loadTf();
    try {
      this.setModel(tf, await tf.loadLayersModel(SERVER_MODEL_URL), meta);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Проверяет, есть ли на сервере новая опубликованная модель; если есть — скачивает,
   * сохраняет для работы без интернета и начинает ею пользоваться.
   * Своя модель пользователя важнее — её не заменяем.
   * @returns {Promise<boolean>} модель обновилась
   */
  async updateFromServer(fetchLatest) {
    if (this.meta?.source === 'local') return false;
    let latest;
    try {
      latest = await fetchLatest();
    } catch {
      return false; // сервера нет или модель не опубликована
    }
    const saved = await db.getMeta(SERVER_META_KEY);
    if (saved?.version === latest.version && this.meta?.source === 'server') return false;
    const tf = await loadTf();
    const model = await tf.loadLayersModel(latest.model_url);
    if (model.getUserDefinedMetadata?.()?.featureVersion !== FEATURE_VERSION) {
      model.dispose();
      return false; // модель старого формата
    }
    const meta = {
      labels: latest.gesture_list.map((g) => (g.category === 'system' ? NONE_LABEL : g.name_tj)),
      accuracy: latest.accuracy,
      validated: true,
      source: 'server',
      version: latest.version,
      trainedAt: latest.created_at,
      featureVersion: FEATURE_VERSION,
    };
    await model.save(SERVER_MODEL_URL);
    await db.setMeta(SERVER_META_KEY, meta);
    this.setModel(tf, model, meta);
    return true;
  }

  async loadBase() {
    const tf = await loadTf();
    try {
      const [model, metrics] = await Promise.all([tf.loadLayersModel(BASE_MODEL_URL), loadBaseMetrics()]);
      const labels = model.getUserDefinedMetadata?.()?.labels ?? metrics?.vocabulary?.map((v) => v.label);
      this.setModel(tf, model, {
        labels,
        accuracy: metrics?.testAccuracy ?? 0,
        validated: true,
        source: 'base',
        trainedAt: metrics?.createdAt,
        featureVersion: FEATURE_VERSION,
        curve: metrics?.curve,
      });
      return true;
    } catch (err) {
      console.warn('[model] Базовая модель не загрузилась:', err);
      return false;
    }
  }

  setModel(tf, model, meta) {
    if (this.model !== model) this.model?.dispose();
    this.tf = tf;
    this.model = model;
    this.meta = meta;
  }

  /**
   * Распознаёт запись (кадры по 132 числа).
   * @returns {{label: string, confidence: number, probs: Float32Array}}
   */
  predict(frames) {
    const tf = this.tf;
    sequenceFeatures(frames, this.input);
    const probs = tf.tidy(() => this.model.predict(tf.tensor2d(this.input, [1, INPUT_SIZE])).dataSync());
    let best = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
    return { label: this.meta.labels[best], confidence: probs[best], probs };
  }

  /**
   * Обучает новую модель на записях пользователя (и, если useBase, на наборе Slovo).
   * @param {{label: string, samples: {frames: number[][]}[]}[]} groups записи пользователя по жестам
   * @param {{useBase?: boolean, onEpoch?: (p: {epoch, epochs, acc, valAcc}) => void}} [opts]
   */
  async train(groups, { useBase = true, onEpoch } = {}) {
    const ownLabels = groups.filter((g) => g.samples.length).map((g) => g.label);
    if (groups.some((g) => g.samples.length && g.samples.length < MIN_SAMPLES)) throw new TrainError('needSamples');

    // Записи: свои (20% каждого жеста — на проверку) + Slovo (проверочные люди — на проверку)
    const trainSet = [];
    const valSet = [];
    for (const g of groups) {
      const shuffled = [...g.samples].sort(() => Math.random() - 0.5);
      const valCount = shuffled.length >= 3 ? Math.max(1, Math.round(shuffled.length * 0.2)) : 0;
      shuffled.forEach((s, i) => (i < valCount ? valSet : trainSet).push({ label: g.label, frames: s.frames, own: true }));
    }
    let baseLabels = [];
    if (useBase) {
      const base = await loadBaseDataset();
      if (base) {
        baseLabels = base.labels;
        for (const s of base.samples) (s.train ? trainSet : valSet).push({ label: s.label, frames: s.frames, own: false });
      }
    }
    const labels = [...new Set([...baseLabels, ...ownLabels])];
    if (labels.length < 2) throw new TrainError('needTwo');
    const labelIndex = new Map(labels.map((l, i) => [l, i]));

    const tf = await loadTf();
    const train = buildMatrix(trainSet, labelIndex, true);
    const val = buildMatrix(valSet, labelIndex, false);
    const validated = val.count > 0;

    const xTrain = tf.tensor2d(train.x, [train.count, INPUT_SIZE]);
    const yTrain = tf.oneHot(tf.tensor1d(train.y, 'int32'), labels.length);
    const xVal = validated ? tf.tensor2d(val.x, [val.count, INPUT_SIZE]) : null;
    const yVal = validated ? tf.oneHot(tf.tensor1d(val.y, 'int32'), labels.length) : null;

    const model = tf.sequential({
      layers: [
        tf.layers.dense({ inputShape: [INPUT_SIZE], units: 256, activation: 'relu' }),
        tf.layers.dropout({ rate: 0.3 }),
        tf.layers.dense({ units: 128, activation: 'relu' }),
        tf.layers.dropout({ rate: 0.2 }),
        tf.layers.dense({ units: labels.length, activation: 'softmax' }),
      ],
    });
    model.compile({ optimizer: tf.train.adam(1e-3), loss: 'categoricalCrossentropy', metrics: ['accuracy'] });

    const curve = [];
    try {
      await model.fit(xTrain, yTrain, {
        epochs: EPOCHS,
        batchSize: 64,
        shuffle: true,
        validationData: validated ? [xVal, yVal] : undefined,
        callbacks: {
          onEpochEnd: async (epoch, logs) => {
            const point = {
              epoch: epoch + 1,
              train: logs.acc ?? logs.accuracy ?? 0,
              test: validated ? (logs.val_acc ?? logs.val_accuracy ?? 0) : undefined,
            };
            curve.push(point);
            onEpoch?.({ ...point, epochs: EPOCHS });
            await tf.nextFrame(); // даём браузеру перерисовать страницу
          },
        },
      });

      // Итоговая проверка — на записях, которых модель не видела
      const evalX = validated ? xVal : xTrain;
      const evalY = validated ? val.y : train.y;
      const predicted = tf.tidy(() => model.predict(evalX).argMax(-1).dataSync());
      const confusion = confusionMatrix(evalY, predicted, labels.length);
      const correct = evalY.reduce((n, y, i) => n + (predicted[i] === y ? 1 : 0), 0);

      const meta = {
        labels,
        accuracy: correct / evalY.length,
        validated,
        confusion,
        curve,
        source: 'local',
        usedBase: baseLabels.length > 0,
        featureVersion: FEATURE_VERSION,
        trainedAt: new Date().toISOString(),
        sampleCount: groups.reduce((n, g) => n + g.samples.length, 0),
      };
      await model.save(this.modelUrl);
      await db.setMeta(this.metaKey, meta);
      this.setModel(tf, model, meta);
      return meta;
    } catch (err) {
      model.dispose();
      throw err;
    } finally {
      tf.dispose([xTrain, yTrain, xVal, yVal].filter(Boolean));
    }
  }

  /** Пары жестов, которые модель путает (по проверочным данным). */
  confusedPairs(threshold = 0.2) {
    const { confusion, labels } = this.meta ?? {};
    if (!confusion) return [];
    const pairs = [];
    confusion.forEach((row, a) => {
      const total = row.reduce((s, v) => s + v, 0);
      row.forEach((count, b) => {
        if (a !== b && total >= 3 && count / total >= threshold) {
          pairs.push({ a: labels[a], b: labels[b], share: count / total });
        }
      });
    });
    return pairs;
  }

  /** Своя модель в виде обычного объекта (для файла резервной копии). */
  async exportModel() {
    if (!this.model || this.meta?.source !== 'local') return null;
    let artifacts;
    await this.model.save(
      this.tf.io.withSaveHandler(async (a) => {
        artifacts = a;
        return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' } };
      }),
    );
    return {
      modelTopology: artifacts.modelTopology,
      weightSpecs: artifacts.weightSpecs,
      weightData: toBase64(joinBuffers(artifacts.weightData)),
      meta: this.meta,
    };
  }

  /** Загружает модель из файла резервной копии и сохраняет в IndexedDB. */
  async importModel(data) {
    if (data?.meta?.featureVersion !== FEATURE_VERSION) throw new Error('old model format');
    const tf = await loadTf();
    const model = await tf.loadLayersModel(
      tf.io.fromMemory({
        modelTopology: data.modelTopology,
        weightSpecs: data.weightSpecs,
        weightData: fromBase64(data.weightData),
      }),
    );
    await model.save(this.modelUrl);
    await db.setMeta(this.metaKey, data.meta);
    this.setModel(tf, model, data.meta);
  }

  /** Удаляет свою модель и возвращается к базовой. */
  async clear() {
    await db.deleteMeta(this.metaKey);
    const tf = await loadTf();
    await tf.io.removeModel(this.modelUrl).catch(() => {});
    this.model?.dispose();
    this.model = null;
    this.meta = null;
  }
}

/** Записи → матрица признаков. Для обучения добавляются случайные копии каждой записи. */
function buildMatrix(samples, labelIndex, withCopies) {
  const rows = [];
  for (const s of samples) {
    const y = labelIndex.get(s.label);
    rows.push([s.frames, y]);
    if (withCopies) {
      const copies = s.own ? COPIES_OWN : COPIES_BASE;
      for (let i = 0; i < copies; i++) rows.push([augment(s.frames), y]);
    }
  }
  const x = new Float32Array(rows.length * INPUT_SIZE);
  rows.forEach(([frames], i) => sequenceFeatures(frames, x.subarray(i * INPUT_SIZE, (i + 1) * INPUT_SIZE)));
  return { x, y: rows.map(([, y]) => y), count: rows.length };
}

function confusionMatrix(yTrue, yPred, n) {
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  yTrue.forEach((y, i) => m[y][yPred[i]]++);
  return m;
}

function joinBuffers(data) {
  if (!Array.isArray(data)) return data;
  const total = data.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of data) {
    out.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return out.buffer;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
