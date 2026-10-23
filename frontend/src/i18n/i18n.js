// Простая локализация: таджикский (по умолчанию) и русский.
// В HTML текст задаётся атрибутами data-i18n="ключ", data-i18n-title="ключ",
// data-i18n-placeholder="ключ", data-i18n-aria-label="ключ".

import tg from './tg.json';
import ru from './ru.json';

const dictionaries = { tg, ru };
const STORAGE_KEY = 'dasti-guyo:lang';
const listeners = new Set();

let lang = readSavedLang() ?? 'tg';

function readSavedLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved in dictionaries ? saved : null;
  } catch {
    // localStorage может быть недоступен (приватный режим) — не страшно
    return null;
  }
}

/** Перевод по ключу. Параметры подставляются вместо {имя}. */
export function t(key, params = {}) {
  const text = dictionaries[lang][key] ?? dictionaries.tg[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`);
}

export function getLang() {
  return lang;
}

export function setLang(next) {
  if (!(next in dictionaries) || next === lang) return;
  lang = next;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* не сохранили — ничего страшного */
  }
  applyI18n();
  listeners.forEach((fn) => fn(lang));
}

/** Подписка на смену языка (для текстов, которые меняются динамически). */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Обновляет все элементы с data-i18n внутри root. */
export function applyI18n(root = document) {
  document.documentElement.lang = lang;
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });
}
