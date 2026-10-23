// Service Worker: сайт работает без интернета.
//   - при установке сохраняет страницу, модели, WASM MediaPipe, базовый набор и озвучку;
//   - файлы сайта, моделей и голоса — сначала из кэша (они не меняются или имеют хэш в имени);
//   - страница и словарь с сервера — сначала из сети, без сети — из кэша.
// При изменении списка файлов увеличьте VERSION — старый кэш удалится.

const VERSION = 'v2';
const CACHE = `dasti-guyo-${VERSION}`;

const PRECACHE = [
  './',
  'index.html',
  'favicon.svg',
  'models/hand_landmarker.task',
  'mediapipe/wasm/vision_wasm_internal.js',
  'mediapipe/wasm/vision_wasm_internal.wasm',
  'models/base/model.json',
  'models/base/weights.bin',
  'models/base/metrics.json',
  'datasets/slovo-base.json',
  'datasets/slovo-base.bin',
  'data/phrases.json',
  'data/quick-phrases.json',
  'audio/tts/index.json',
  'avatar/avatar.glb',
];

// Ответы API, которые полезно иметь без сети
const API_CACHE = ['/api/v1/dictionary', '/api/v1/models/latest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE);
      // Все озвученные слова и фразы — по списку из index.json
      try {
        const index = await (await fetch('audio/tts/index.json')).json();
        await cache.addAll(Object.values(index.files).map((f) => `audio/tts/${f}`));
      } catch {
        /* без голоса тоже можно работать */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('dasti-guyo-') && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
  return response;
}

async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  } catch {
    const cached = (await caches.match(request)) ?? (fallbackUrl && (await caches.match(fallbackUrl)));
    if (cached) return cached;
    throw new Error('offline');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Страница: свежая из сети, без сети — сохранённая
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, 'index.html'));
    return;
  }
  // API: только то, что нужно офлайн (словарь, сведения о модели)
  if (url.pathname.startsWith('/api/')) {
    if (API_CACHE.includes(url.pathname)) event.respondWith(networkFirst(request));
    return;
  }
  // Словарь фраз может меняться — сначала из сети
  if (/\/data\//.test(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }
  // Файлы моделей с сервера, сборка сайта, модели, голос, шрифты — из кэша
  if (
    url.pathname.startsWith('/media/models/') ||
    /\/(assets|models|mediapipe|datasets|audio|avatar)\//.test(url.pathname) ||
    url.pathname.endsWith('.svg')
  ) {
    event.respondWith(cacheFirst(request));
  }
});
