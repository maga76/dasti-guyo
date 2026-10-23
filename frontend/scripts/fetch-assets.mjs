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
const modelDst = join(root, 'public', 'models', 'hand_landmarker.task');

// Версия «1» зафиксирована, чтобы модель не менялась сама по себе
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

async function copyWasm() {
  if (!existsSync(wasmSrc)) {
    console.warn('[assets] Нет node_modules/@mediapipe/tasks-vision — сначала выполните npm install');
    return;
  }
  await mkdir(wasmDst, { recursive: true });
  await cp(wasmSrc, wasmDst, { recursive: true });
  console.log('[assets] WASM MediaPipe скопирован в public/mediapipe/wasm');
}

async function downloadModel() {
  if (existsSync(modelDst) && (await stat(modelDst)).size > 1_000_000) {
    console.log('[assets] Модель руки уже есть: public/models/hand_landmarker.task');
    return;
  }
  await mkdir(dirname(modelDst), { recursive: true });
  const tmp = modelDst + '.part';
  try {
    console.log('[assets] Скачиваю модель руки (~7.5 МБ)...');
    const res = await fetch(MODEL_URL, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(tmp, buf);
    await rename(tmp, modelDst);
    console.log(`[assets] Модель сохранена (${(buf.length / 1e6).toFixed(1)} МБ)`);
  } catch (err) {
    if (existsSync(tmp)) await unlink(tmp);
    console.warn(`[assets] Не удалось скачать модель: ${err.message}`);
    console.warn('[assets] Сайт будет загружать модель с CDN. Повторить: npm run assets');
  }
}

await copyWasm();
await downloadModel();
