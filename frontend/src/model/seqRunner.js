// Новая нейросеть (seqModel.js) со стороны страницы: загружает веса, запускает фоновый поток
// seqWorker.js и отдаёт ему записи. Включается переключателем в «Технических данных»
// (по умолчанию включена); работает вместо базовой MLP, пока человек не обучил свою модель.

import { assetUrls, download, downloadJson } from '../net/download.js';

const KEY = 'dasti-guyo:seqModel';

export function isSeqEnabled() {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function setSeqEnabled(on) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* не запомнится */
  }
}

export class SeqRunner {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.error = null;
    this.labels = [];
    this.lastMs = 0;
    this.nextId = 0;
    this.waiting = new Map();
  }

  async load() {
    try {
      const [meta, weights] = await Promise.all([
        downloadJson(assetUrls('models/seq/model.json')),
        download(assetUrls('models/seq/weights.bin')),
      ]);
      const worker = new Worker(new URL('./seqWorker.js', import.meta.url), { type: 'module' });
      await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => (data.type === 'ready' ? resolve() : reject(new Error(data.message)));
        worker.onerror = (e) => reject(new Error(e.message || 'seq worker'));
        worker.postMessage({ type: 'load', meta, weights: weights.slice(0) });
      });
      worker.onmessage = ({ data }) => {
        if (data.type !== 'probs') return;
        this.lastMs = data.ms / Math.max(1, data.probs.length);
        this.waiting.get(data.id)?.(data.probs);
        this.waiting.delete(data.id);
      };
      this.worker = worker;
      this.labels = meta.labels;
      this.meta = meta;
      this.ready = true;
    } catch (err) {
      this.error = err;
      console.warn('[seq] Новая нейросеть не загрузилась — работает прежняя:', err);
    }
  }

  /**
   * @param {ArrayLike<number>[][]} clips записи (кадры по 132 числа)
   * @returns {Promise<Float32Array[]>}
   */
  predict(clips) {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ type: 'predict', id, clips });
    });
  }
}
