// Базовый набор жестов из открытого датасета Slovo (русский жестовый язык).
// Собирается скриптом backend/tools/build_slovo_base.py.
//
// Нужен для двух вещей:
//   1) переобучать модель в браузере вместе с записями пользователя;
//   2) показывать, как выполняется жест (анимация точек рук).
// Хранится компактно: 32 кадра × 132 числа в int16 (× 1000).

import { assetUrls, download, downloadJson } from '../net/download.js';

let cache = null;

/**
 * @returns {Promise<{labels: string[], vocabulary: object[], source: string,
 *   samples: {label: string, train: boolean, frames: Float32Array[]}[]} | null>}
 */
export function loadBaseDataset() {
  cache ??= (async () => {
    try {
      const [index, bin] = await Promise.all([
        downloadJson(assetUrls('datasets/slovo-base.json')),
        download(assetUrls('datasets/slovo-base.bin')),
      ]);
      const values = new Int16Array(bin);
      const { frameSize, framesPerSample, scale } = index;
      const perSample = frameSize * framesPerSample;
      const samples = index.samples.map(([labelIndex, train], i) => {
        const frames = [];
        for (let f = 0; f < framesPerSample; f++) {
          const frame = new Float32Array(frameSize);
          const offset = i * perSample + f * frameSize;
          for (let k = 0; k < frameSize; k++) frame[k] = values[offset + k] / scale;
          frames.push(frame);
        }
        return { label: index.labels[labelIndex], train: train === 1, frames };
      });
      return { labels: index.labels, vocabulary: index.vocabulary, source: index.source, samples };
    } catch (err) {
      console.warn('[base] Базовый набор не загрузился:', err);
      cache = null; // попробуем ещё раз позже
      return null;
    }
  })();
  return cache;
}

/** Метрики базовой модели (точность, график обучения) — для экрана «Дар бораи ИИ». */
export async function loadBaseMetrics() {
  try {
    return await downloadJson(assetUrls('models/base/metrics.json'));
  } catch {
    return null;
  }
}
