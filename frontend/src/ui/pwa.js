// Установка сайта как приложения (значок на телефоне/компьютере, отдельное окно, работа без
// интернета — через Service Worker). Chrome/Edge/Android присылают событие beforeinstallprompt —
// его сохраняем и показываем свою кнопку. На iPhone такого события нет: там подсказываем
// «Поделиться → На экран Домой».

let deferred = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // своё окно покажем по кнопке
  deferred = e;
  notify();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  notify();
});

/** 'ready' — можно установить кнопкой; 'installed' — уже открыто как приложение; 'ios'; 'none'. */
export function installState() {
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return 'installed';
  if (deferred) return 'ready';
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return 'ios';
  return 'none';
}

export async function install() {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  notify();
  return outcome === 'accepted';
}

export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
