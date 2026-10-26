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
    // privacy.html — простая страница, её правки не должны менять адрес тяжёлых файлов на CDN
    return execSync('git log -1 --format=%H -- public ":(exclude)public/privacy.html"', { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
const mediapipeVersion = JSON.parse(
  readFileSync(new URL('./node_modules/@mediapipe/tasks-vision/package.json', import.meta.url), 'utf8'),
).version;

// HTTPS=1 (npm run dev:phone) — сайт по HTTPS, чтобы камера работала на телефоне
// в той же Wi-Fi сети. Сертификат самоподписанный: браузер предупредит, это нормально.
const https = process.env.HTTPS === '1';
const backend = process.env.BACKEND_URL || 'http://localhost:8000';

export default defineConfig({
  plugins: https ? [basicSsl()] : [],
  define: {
    __ASSET_REF__: JSON.stringify(assetRef()),
    __MEDIAPIPE_VERSION__: JSON.stringify(mediapipeVersion),
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
