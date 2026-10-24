// Service Worker: сайт работает без интернета.
//   - при установке сохраняет только саму страницу и мелкие файлы. Большие файлы (модель руки,
//     MediaPipe, аватары, набор жестов) сохраняются тогда, когда понадобились впервые
//     (src/net/download.js) — иначе на медленном интернете они мешали бы загрузке страницы;
//   - файлы сайта, моделей и голоса — сначала из кэша (они не меняются или имеют хэш в имени);
//   - страница и словарь с сервера — сначала из сети, без сети — из кэша.
// При изменении списка файлов увеличьте VERSION — старый кэш удалится.

const VERSION = 'v4';
const CACHE = `dasti-guyo-${VERSION}`;

const PRECACHE = ['./', 'index.html', 'favicon.svg', 'data/phrases.json', 'data/quick-phrases.json', 'audio/tts/index.json'];

// Ответы API, которые полезно иметь без сети
const API_CACHE = ['/api/v1/dictionary', '/api/v1/models/latest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await (await caches.open(CACHE)).addAll(PRECACHE);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        // dasti-guyo-files-* — большие файлы (net/download.js), они живут между версиями
        if (key.startsWith('dasti-guyo-v') && key !== CACHE) await caches.delete(key);
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
  // Куски файлов (Range) качает net/download.js сам и сам же сохраняет готовый файл
  if (request.method !== 'GET' || request.headers.has('range')) return;
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
