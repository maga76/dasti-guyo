import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS=1 (npm run dev:phone) — сайт по HTTPS, чтобы камера работала на телефоне
// в той же Wi-Fi сети. Сертификат самоподписанный: браузер предупредит, это нормально.
const https = process.env.HTTPS === '1';
const backend = process.env.BACKEND_URL || 'http://localhost:8000';

export default defineConfig({
  plugins: https ? [basicSsl()] : [],
  server: {
    port: 5173,
    host: true, // доступ с других устройств в сети
    // Запросы к API и файлам моделей идут на бэкенд через этот же адрес:
    // не нужен CORS и нет «смешанного содержимого» на HTTPS
    proxy: {
      '/api': backend,
      '/media': backend,
    },
  },
  preview: {
    port: 4173,
    host: true,
    proxy: {
      '/api': backend,
      '/media': backend,
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // TensorFlow.js — большой отдельный файл, грузится только когда нужен
    chunkSizeWarningLimit: 2000,
  },
});
