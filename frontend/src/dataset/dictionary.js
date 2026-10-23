// Словарь фраз: правила сборки предложений и быстрые фразы.
// Берётся с сервера (/dictionary), а если сервер недоступен — из файлов public/data.
// Service Worker кэширует оба источника, поэтому словарь есть и без интернета.

import { api } from '../api/api.js';

const base = import.meta.env.BASE_URL;
let cache = null;

async function localJson(name) {
  try {
    const res = await fetch(`${base}data/${name}`);
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

/** @returns {Promise<{phrases: {words: string[], text_tj: string, text_ru: string}[], quickPhrases: {text_tj: string, text_ru: string}[]}>} */
export function loadDictionary() {
  cache ??= (async () => {
    const [phrasesFile, quickFile] = await Promise.all([localJson('phrases.json'), localJson('quick-phrases.json')]);
    let phrases = phrasesFile.phrases ?? [];
    let quickPhrases = quickFile.quick_phrases ?? [];
    try {
      const server = await api('/dictionary', { timeout: 5000 });
      // Правила с сервера дополняют встроенные; быстрые фразы сервера (если есть) главнее
      phrases = [...server.phrases, ...phrases];
      if (server.quick_phrases.length) quickPhrases = server.quick_phrases;
    } catch {
      /* без сервера — встроенные файлы */
    }
    return { phrases, quickPhrases };
  })();
  return cache;
}

const norm = (s) => s.trim().toLowerCase();

/**
 * Собирает предложение из распознанных слов по правилам.
 * Ищет самое длинное правило, начинающееся с каждого слова; остальные слова — как есть.
 * @param {string[]} words
 * @returns {{tj: string, ru: string, matched: boolean}}
 */
export function buildSentence(words, rules) {
  const tj = [];
  const ru = [];
  let matched = false;
  let i = 0;
  while (i < words.length) {
    let best = null;
    for (const rule of rules) {
      const n = rule.words.length;
      if (n > (best?.words.length ?? 0) && i + n <= words.length && rule.words.every((w, k) => norm(w) === norm(words[i + k]))) {
        best = rule;
      }
    }
    if (best) {
      tj.push(best.text_tj);
      ru.push(best.text_ru || best.text_tj);
      matched = true;
      i += best.words.length;
    } else {
      tj.push(words[i]);
      ru.push(words[i]);
      i++;
    }
  }
  const cap = (parts) => {
    const text = parts.join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  };
  return { tj: cap(tj), ru: cap(ru), matched };
}
