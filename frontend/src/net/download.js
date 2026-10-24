// Надёжная загрузка больших файлов (модель руки, MediaPipe, аватары, набор жестов).
//
// Интернет у пользователей бывает медленным и рвётся. Поэтому:
//   1) сначала — бесплатный CDN jsDelivr (быстрый в любой стране), потом — наш сервер;
//   2) зависшую загрузку прерываем и повторяем;
//   3) если файл целиком не скачивается — качаем кусками по 512 КБ (HTTP Range):
//      обрыв связи теряет только один кусок, а не всё скачанное;
//   4) скачанный файл сохраняется в браузере — второй раз грузится мгновенно и без интернета.

const base = import.meta.env.BASE_URL;
const REPO = 'maga76/dasti-guyo';
// Коммит, в котором лежат эти файлы (подставляет vite.config.js при сборке).
// В разработке CDN не используется, если не открыть страницу с ?cdn=1.
const ASSET_REF = typeof __ASSET_REF__ === 'string' ? __ASSET_REF__ : '';
const MEDIAPIPE_VERSION = typeof __MEDIAPIPE_VERSION__ === 'string' ? __MEDIAPIPE_VERSION__ : '';
const useCdn = !import.meta.env.DEV || new URLSearchParams(location.search).has('cdn');

const CACHE = 'dasti-guyo-files-v1';
const CHUNK = 512 * 1024;
const STALL_MS = 20_000; // столько ждём новых байт, прежде чем считать загрузку зависшей
const CHUNK_RETRIES = 6;

/** Адреса файла из public/: CDN (если доступен) и наш сервер. */
export function assetUrls(path) {
  const local = `${base}${path}`;
  if (!useCdn || !ASSET_REF) return [local];
  return [`https://cdn.jsdelivr.net/gh/${REPO}@${ASSET_REF}/frontend/public/${path}`, local];
}

/** Папка WASM MediaPipe: CDN (тот же npm-пакет, что в сборке) и наш сервер. */
export function mediapipeWasmBases() {
  const local = `${base}mediapipe/wasm`;
  if (!useCdn || !MEDIAPIPE_VERSION) return [local];
  return [`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`, local];
}

/**
 * Скачать файл по первому доступному адресу.
 * @param {string[]} urls адреса по порядку
 * @param {{onProgress?: (percent: number|null) => void, cacheKey?: string}} [options]
 *   cacheKey — под каким именем хранить в браузере (по умолчанию первый адрес)
 * @returns {Promise<ArrayBuffer>}
 */
export async function download(urls, { onProgress, cacheKey = urls[0] } = {}) {
  // Навсегда сохраняем только файлы с «вечным» адресом (CDN с номером коммита, CDN Google):
  // файл с нашего сервера по тому же адресу может обновиться
  if (!/^https:/.test(cacheKey)) cacheKey = null;
  const cached = await readCache(cacheKey);
  if (cached) {
    onProgress?.(100);
    return cached;
  }
  const errors = [];
  // Целиком (сервер сжимает — быстрее), по каждому адресу
  for (const url of urls) {
    try {
      return await keep(cacheKey, await fetchWhole(url, onProgress));
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  // Кусками — устойчиво к обрывам
  for (const url of urls) {
    try {
      return await keep(cacheKey, await fetchChunks(url, onProgress));
    } catch (err) {
      errors.push(`${url} (по частям): ${err.message}`);
    }
  }
  throw new Error(`Файл не скачался:\n${errors.join('\n')}`);
}

/** То же, но результат — JSON. */
export async function downloadJson(urls, options) {
  return JSON.parse(new TextDecoder().decode(await download(urls, options)));
}

/** Повторить динамический import(), если файл сборки не скачался с первого раза. */
export async function importRetry(load, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await load();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

// ---------- внутреннее ----------

/** Запрос, который прерывается, если байты перестали приходить. */
async function fetchWhole(url, onProgress) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), STALL_MS);
  const poke = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), STALL_MS);
  };
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    checkResponse(res);
    // Размер известен, только если файл не сжат при передаче
    const total = res.headers.get('content-encoding') ? 0 : Number(res.headers.get('content-length')) || 0;
    if (!res.body) return await res.arrayBuffer();
    const reader = res.body.getReader();
    const parts = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      poke();
      parts.push(value);
      received += value.length;
      onProgress?.(total ? Math.min(99, Math.round((received / total) * 100)) : null);
    }
    onProgress?.(100);
    return join(parts, received);
  } catch (err) {
    throw ctrl.signal.aborted ? new Error('загрузка зависла') : err;
  } finally {
    clearTimeout(timer);
  }
}

/** Скачивание кусками по HTTP Range: каждый кусок повторяется отдельно. */
async function fetchChunks(url, onProgress) {
  const parts = [];
  let received = 0;
  let total = Infinity;
  while (received < total) {
    const end = Math.min(received + CHUNK, total) - 1;
    let chunk;
    for (let attempt = 1; ; attempt++) {
      try {
        chunk = await fetchRange(url, received, end);
        break;
      } catch (err) {
        if (attempt >= CHUNK_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    // Сервер не умеет Range — прислал файл целиком
    if (chunk.whole) return chunk.data;
    total = chunk.total;
    parts.push(new Uint8Array(chunk.data));
    received += chunk.data.byteLength;
    onProgress?.(Math.min(99, Math.round((received / total) * 100)));
  }
  onProgress?.(100);
  return join(parts, received);
}

async function fetchRange(url, start, end) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STALL_MS);
  try {
    // no-store: иначе браузер может склеить кусок из своего кэша неправильно
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, cache: 'no-store', signal: ctrl.signal });
    checkResponse(res);
    const data = await res.arrayBuffer();
    if (res.status !== 206) return { whole: true, data };
    const total = Number(res.headers.get('content-range')?.split('/')[1]);
    if (!total) throw new Error('нет размера файла');
    return { data, total };
  } finally {
    clearTimeout(timer);
  }
}

function checkResponse(res) {
  // Dev-сервер на отсутствующий файл отвечает index.html — это не тот файл
  if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`HTTP ${res.status}`);
  }
}

function join(parts, size) {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out.buffer;
}

async function readCache(key) {
  if (!key) return null;
  try {
    const res = await (await caches.open(CACHE)).match(key);
    return res ? await res.arrayBuffer() : null;
  } catch {
    return null; // без Cache Storage (приватный режим, http) — просто качаем
  }
}

async function keep(key, buffer) {
  if (!key) return buffer;
  try {
    await (await caches.open(CACHE)).put(key, new Response(buffer));
  } catch {
    /* не сохранилось — в следующий раз скачаем снова */
  }
  return buffer;
}
