// «Оболочка» сайта: плашка «Установить приложение» на телефоне (как на king.tj), кнопка установки
// в подвале и нижнее меню телефона с листом «Ҳама» (все разделы).

import { onLangChange, t } from '../i18n/i18n.js';
import { isMobile } from '../device.js';
import { install, installState, onInstallChange } from './pwa.js';

const $ = (id) => document.getElementById(id);
const DISMISS_KEY = 'dasti-guyo:installDismissed';
const DISMISS_DAYS = 14;

function dismissedRecently() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return Date.now() - at < DISMISS_DAYS * 864e5;
  } catch {
    return false;
  }
}

function paintInstall() {
  const state = installState();
  // Плашка — только на телефоне, если можно установить и её не закрывали недавно
  const banner = $('installBanner');
  banner.hidden = !(isMobile && (state === 'ready' || state === 'ios') && !dismissedRecently());
  $('installBannerBtn').hidden = state !== 'ready';
  $('installBannerIos').hidden = state !== 'ios';
  // Компьютер: кнопка «Насб кардан» в шапке (на телефоне вместо неё — плашка)
  $('btnInstallTop').hidden = isMobile || state !== 'ready';
  // Подвал: кнопка, если браузер умеет ставить; иначе — подсказка
  $('footInstall').hidden = state !== 'ready';
  $('footInstallHint').textContent = t(
    state === 'installed' ? 'about.installed' : state === 'ios' ? 'about.installIos' : state === 'ready' ? 'foot.scanOrInstall' : 'foot.scan',
  );
}

function toggleMore(open) {
  $('moreSheet').hidden = !open;
  $('btnMore').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('sheet-open', open);
}

export function initShell() {
  for (const id of ['installBannerBtn', 'footInstall', 'btnInstallTop']) $(id).addEventListener('click', () => install());
  $('installBannerClose').addEventListener('click', () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* просто скроем до перезагрузки */
    }
    $('installBanner').hidden = true;
  });
  $('btnMore').addEventListener('click', () => toggleMore($('moreSheet').hidden));
  $('moreSheet').addEventListener('click', (e) => {
    // Нажали ссылку или фон — закрыть лист
    if (e.target.closest('a') || e.target === $('moreSheet')) toggleMore(false);
  });
  window.addEventListener('hashchange', () => toggleMore(false));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && toggleMore(false));
  onInstallChange(paintInstall);
  onLangChange(paintInstall);
  paintInstall();
}
