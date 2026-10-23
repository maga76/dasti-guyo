// Значок сети в шапке: «Онлайн» / «Бе сервер» / «Офлайн».
// Без интернета сайт всё равно переводит: модель, словарь и голос сохранены в браузере.

import { onLangChange, t } from '../i18n/i18n.js';
import { isServerUp } from '../api/api.js';

const CHECK_EVERY_MS = 30_000;
let state = null;

function render() {
  const badge = document.getElementById('netBadge');
  if (!state) return;
  badge.hidden = false;
  badge.dataset.state = state;
  badge.textContent = t({ online: 'net.online', noServer: 'net.noServer', offline: 'net.offline' }[state]);
  badge.title = t({ online: 'net.onlineHint', noServer: 'net.noServerHint', offline: 'net.offlineHint' }[state]);
}

async function check() {
  state = !navigator.onLine ? 'offline' : (await isServerUp()) ? 'online' : 'noServer';
  render();
}

export function initNetworkBadge() {
  check();
  setInterval(check, CHECK_EVERY_MS);
  window.addEventListener('online', check);
  window.addEventListener('offline', check);
  onLangChange(render);
}
