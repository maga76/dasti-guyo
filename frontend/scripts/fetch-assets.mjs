// Подготовка локальных ресурсов MediaPipe перед запуском/сборкой.
// 1) Копирует WASM-файлы из node_modules в public/mediapipe/wasm
// 2) Скачивает модель руки в public/models (один раз)
// Зачем: сайт должен работать офлайн, поэтому всё, что нужно для распознавания,
// раздаётся с нашего же сервера и кэшируется Service Worker'ом.
// Если скачать модель не удалось — сборка не падает, сайт возьмёт её с CDN Google.

import { cp, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = join(root, 'public', 'mediapipe', 'wasm');
// Версия «1» зафиксирована, чтобы модели не менялись сами по себе
const MODELS = [
  {
    // Кисти: 21 точка на руке
    dst: join(root, 'public', 'models', 'hand_landmarker.task'),
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  },
  {
    // Поза тела: по запястьям отсеиваются ложные руки (лицо, узоры)
    dst: join(root, 'public', 'models', 'pose_landmarker_lite.task'),
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  },
];

async function copyWasm() {
  if (!existsSync(wasmSrc)) {
    console.warn('[assets] Нет node_modules/@mediapipe/tasks-vision — сначала выполните npm install');
    return;
  }
  await mkdir(wasmDst, { recursive: true });
  await cp(wasmSrc, wasmDst, { recursive: true });
  console.log('[assets] WASM MediaPipe скопирован в public/mediapipe/wasm');
}

async function downloadModel({ dst, url }) {
  const name = dst.split(/[\\/]/).pop();
  if (existsSync(dst) && (await stat(dst)).size > 1_000_000) {
    console.log(`[assets] Модель уже есть: public/models/${name}`);
    return;
  }
  await mkdir(dirname(dst), { recursive: true });
  const tmp = dst + '.part';
  try {
    console.log(`[assets] Скачиваю ${name}...`);
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(tmp, buf);
    await rename(tmp, dst);
    console.log(`[assets] ${name} сохранена (${(buf.length / 1e6).toFixed(1)} МБ)`);
  } catch (err) {
    if (existsSync(tmp)) await unlink(tmp);
    console.warn(`[assets] Не удалось скачать ${name}: ${err.message}`);
    console.warn('[assets] Сайт будет загружать модель с CDN Google. Повторить: npm run assets');
  }
}

await copyWasm();
for (const model of MODELS) await downloadModel(model);
