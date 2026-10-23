// npm run dev:phone — сайт по HTTPS для проверки на телефоне в той же Wi-Fi сети.
// Камера в браузере телефона работает только по HTTPS. Сертификат самоподписанный:
// на телефоне нажмите «Дополнительно» → «Перейти на сайт».

import { createServer } from 'vite';

process.env.HTTPS = '1';
await import('./fetch-assets.mjs');

const server = await createServer();
await server.listen();
console.log('\n  Откройте на телефоне адрес «Network» ниже (https://…).\n');
server.printUrls();
