import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Большие файлы сайт берёт с бесплатного CDN jsDelivr прямо из репозитория GitHub
// (src/net/download.js). Нужен номер последнего коммита, где менялась папка public/:
// у файла по такому адресу содержимое никогда не меняется. Нет git — CDN не используется.
function assetRef() {
  try {
    const cwd = fileURLToPath(new URL('.', import.meta.url));
    // privacy.html и значок — мелочи, их правки не должны менять адрес тяжёлых файлов на CDN.
    // Записи нового голоса добавляются понемногу и берутся с нашего сервера (speech.js)
    return execSync(
      'git log -1 --format=%H -- public ":(exclude)public/privacy.html" ":(exclude)public/favicon.svg" ' +
        '":(exclude)public/robots.txt" ":(exclude)public/sitemap.xml" ":(exclude)public/og.png" ' +
        '":(exclude)public/audio/achernar" ":(exclude)public/sw.js"',
      {
        cwd,
        encoding: 'utf8',
      },
    ).trim();
  } catch {
    return '';
  }
}
const mediapipeVersion = JSON.parse(
  readFileSync(new URL('./node_modules/@mediapipe/tasks-vision/package.json', import.meta.url), 'utf8'),
).version;

// Поисковики и превью ссылок (Telegram, WhatsApp) часто не запускают JavaScript и видели бы
// пустые подписи. При сборке вписываем в index.html таджикский текст всех data-i18n="ключ" —
// сайт после загрузки всё равно подставит выбранный язык (src/i18n/i18n.js).
function prefillI18n() {
  const tg = JSON.parse(readFileSync(new URL('./src/i18n/tg.json', import.meta.url), 'utf8'));
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    name: 'prefill-i18n',
    transformIndexHtml(html) {
      return html.replace(/(<([a-z0-9]+)\b[^>]*\sdata-i18n="([^"]+)"[^>]*>)(<\/\2>)/g, (all, open, tag, key, close) =>
        typeof tg[key] === 'string' && !tg[key].includes('{') ? open + esc(tg[key]) + close : all,
      );
    },
  };
}

// HTTPS=1 (npm run dev:phone) — сайт по HTTPS, чтобы камера работала на телефоне
// в той же Wi-Fi сети. Сертификат самоподписанный: браузер предупредит, это нормально.
const https = process.env.HTTPS === '1';
const backend = process.env.BACKEND_URL || 'http://localhost:8000';

export default defineConfig({
  plugins: [prefillI18n(), ...(https ? [basicSsl()] : [])],
  define: {
    __ASSET_REF__: JSON.stringify(assetRef()),
    __MEDIAPIPE_VERSION__: JSON.stringify(mediapipeVersion),
  },
  // Фоновый поток распознавания рук (src/hands/handWorker.js) — модуль: так MediaPipe
  // может загрузить свой WASM-загрузчик через import()
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    host: true, // доступ с других устройств в сети
    // Запросы к API и файлам моделей идут на бэкенд через этот же адрес:
    // не нужен CORS и нет «смешанного содержимого» на HTTPS
    // '/media/' со слэшем: иначе сюда попадал бы и '/mediapipe/…' (WASM распознавания рук)
    proxy: {
      '/api': backend,
      '/media/': backend,
    },
  },
  preview: {
    port: 4173,
    host: true,
    proxy: {
      '/api': backend,
      '/media/': backend,
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // TensorFlow.js — большой отдельный файл, грузится только когда нужен
    chunkSizeWarningLimit: 2000,
  },
});
