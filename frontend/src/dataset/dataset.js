// Набор примеров жестов: хранение, сводка, предупреждения, экспорт/импорт.

import { db } from './db.js';
import { FRAME, INPUT_SIZE, sequenceFeatures } from './features.js';

/** Служебный класс «нет жеста» (руки опущены, случайные движения). */
export const NONE_LABEL = '__none__';

/** Меньше этого — обучать нельзя. */
export const MIN_SAMPLES = 3;
/** Рекомендуемый минимум (столько же требует сервер для обучения). */
export const RECOMMENDED_SAMPLES = 20;

const BACKUP_FORMAT = 'dasti-guyo-backup';

export async function addSample({ label, frames, handCount }) {
  const sample = {
    uid: crypto.randomUUID(),
    label,
    frames,
    handCount,
    createdAt: new Date().toISOString(),
    synced: false, // будет использовано на этапе 5 (отправка на сервер)
  };
  sample.id = await db.addSample(sample);
  await touchDataset();
  return sample;
}

export async function deleteSample(id) {
  await db.deleteSample(id);
  await touchDataset();
}

export async function deleteLabel(label) {
  await db.deleteLabel(label);
  await touchDataset();
}

export const getAllSamples = () => db.getAllSamples();

/** Отметка «данные изменились» — чтобы предложить переобучить модель. */
async function touchDataset() {
  await db.setMeta('datasetChangedAt', new Date().toISOString());
}

export const getDatasetChangedAt = () => db.getMeta('datasetChangedAt');

/**
 * Группирует примеры по жестам в порядке первой записи.
 * @returns {{label: string, samples: object[]}[]}
 */
export function groupByLabel(samples) {
  const groups = new Map();
  for (const s of [...samples].sort((a, b) => a.id - b.id)) {
    if (!groups.has(s.label)) groups.set(s.label, []);
    groups.get(s.label).push(s);
  }
  return [...groups].map(([label, items]) => ({ label, samples: items }));
}

/**
 * Предупреждения о качестве данных.
 * @returns {({type:'few', label, n} | {type:'similar', a, b} | {type:'noNone'})[]}
 */
export function findWarnings(groups) {
  const warnings = [];
  if (groups.length && !groups.some((g) => g.label === NONE_LABEL)) warnings.push({ type: 'noNone' });

  for (const g of groups) {
    if (g.samples.length < RECOMMENDED_SAMPLES) warnings.push({ type: 'few', label: g.label, n: g.samples.length });
  }

  // Похожие жесты: средние движения ближе друг к другу, чем разброс записей внутри жеста.
  // «Нет жеста» не сравниваем — он и должен быть разным.
  const stats = groups.filter((g) => g.label !== NONE_LABEL).map((g) => ({ label: g.label, ...centroid(g.samples) }));
  for (let i = 0; i < stats.length; i++) {
    for (let j = i + 1; j < stats.length; j++) {
      const a = stats[i];
      const b = stats[j];
      if (distance(a.center, b.center) < 0.6 * (a.spread + b.spread)) {
        warnings.push({ type: 'similar', a: a.label, b: b.label });
      }
    }
  }
  return warnings;
}

/** Среднее движение жеста и средний разброс записей вокруг него. */
function centroid(samples) {
  const vectors = samples.map((s) => sequenceFeatures(s.frames));
  const center = new Float64Array(INPUT_SIZE);
  for (const v of vectors) for (let k = 0; k < INPUT_SIZE; k++) center[k] += v[k];
  for (let k = 0; k < INPUT_SIZE; k++) center[k] /= vectors.length || 1;
  const spread = vectors.reduce((sum, v) => sum + distance(v, center), 0) / (vectors.length || 1);
  return { center, spread };
}

function distance(a, b) {
  let sum = 0;
  for (let k = 0; k < INPUT_SIZE; k++) sum += (a[k] - b[k]) ** 2;
  return Math.sqrt(sum);
}

// ---------- Экспорт / импорт ----------

/**
 * Собирает всё в один объект: примеры + модель + словарь (список жестов).
 * @param {object|null} model результат classifier.exportModel()
 */
export async function buildBackup(model) {
  const samples = await db.getAllSamples();
  return {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    dictionary: groupByLabel(samples).map((g) => ({ label: g.label, samples: g.samples.length })),
    samples: samples.map(({ id, ...rest }) => ({
      ...rest,
      // 4 знака после запятой — файл в несколько раз меньше, точность не страдает
      frames: rest.frames.map((f) => f.map((v) => Math.round(v * 1e4) / 1e4)),
    })),
    model,
  };
}

export function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Читает файл резервной копии. Примеры ДОБАВЛЯЮТСЯ к текущим (дубликаты пропускаются),
 * так можно объединять записи с разных компьютеров.
 * @returns {Promise<{added: number, model: object|null}>}
 */
export async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('badFile');
  }
  if (data?.format !== BACKUP_FORMAT || !Array.isArray(data.samples)) throw new Error('badFile');

  const existing = new Set((await db.getAllSamples()).map((s) => s.uid));
  let added = 0;
  for (const s of data.samples) {
    if (!isValidSample(s) || existing.has(s.uid)) continue;
    await db.addSample({
      uid: s.uid || crypto.randomUUID(),
      label: String(s.label),
      frames: s.frames,
      handCount: s.handCount ?? 1,
      createdAt: s.createdAt ?? new Date().toISOString(),
      synced: false,
    });
    added++;
  }
  if (added) await touchDataset();
  return { added, model: data.model ?? null };
}

function isValidSample(s) {
  return (
    s &&
    typeof s.label === 'string' &&
    s.label.length > 0 &&
    Array.isArray(s.frames) &&
    s.frames.length > 0 &&
    s.frames.every((f) => Array.isArray(f) && f.length === FRAME && f.every(Number.isFinite))
  );
}
