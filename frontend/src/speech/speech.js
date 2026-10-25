// Озвучка по-таджикски. Источники по порядку:
//   1) заранее озвученные файлы нейросети MMS-TTS (public/audio/tts) — работают без интернета;
//   2) сервер /tts — та же нейросеть для новых фраз (если на сервере она установлена);
//   3) голос браузера: таджикский, если есть (редко), иначе русский — он есть почти везде
//      и хорошо читает таджикскую кириллицу, если особые буквы заменить близкими (ӣ→и, ҳ→х …).
//      Так звучат и слова, которые человек сам добавил во вкладке «Омӯзиш»;
//   4) ничего — тогда сайт просто показывает текст.

import { config } from '../config.js';

const base = import.meta.env.BASE_URL;
let indexPromise = null;
let current = null; // текущий HTMLAudioElement

/** Такой же вид текста, как на сервере (app/services/tts.py → normalize). */
export const normalize = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ');

function loadIndex() {
  indexPromise ??= fetch(`${base}audio/tts/index.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return indexPromise;
}

// Буквы таджикского алфавита, которых нет в русском, → как их прочитает русский голос
const TAJIK_TO_RUSSIAN = { ӣ: 'и', Ӣ: 'И', ӯ: 'у', Ӯ: 'У', ҳ: 'х', Ҳ: 'Х', қ: 'к', Қ: 'К', ғ: 'г', Ғ: 'Г', ҷ: 'дж', Ҷ: 'Дж' };
export const forRussianVoice = (text) => text.replace(/[ӣӢӯӮҳҲқҚғҒҷҶ]/g, (c) => TAJIK_TO_RUSSIAN[c]);

/** Голоса браузера появляются не сразу — ждём их до секунды. */
async function voices() {
  const synth = window.speechSynthesis;
  if (!synth) return [];
  let list = synth.getVoices();
  if (!list.length) {
    await new Promise((resolve) => {
      synth.addEventListener('voiceschanged', resolve, { once: true });
      setTimeout(resolve, 1000);
    });
    list = synth.getVoices();
  }
  return list;
}

/** Голос браузера: таджикский, если есть, иначе русский. {voice, tajik} или null. */
async function browserVoice() {
  const list = await voices();
  const lang = (v) => v.lang.toLowerCase();
  const tg = list.find((v) => lang(v).startsWith('tg'));
  if (tg) return { voice: tg, tajik: true };
  // Локальный русский голос лучше: работает без интернета и без задержки
  const ru = list.filter((v) => lang(v).startsWith('ru'));
  const voice = ru.find((v) => v.localService) ?? ru[0];
  return voice ? { voice, tajik: false } : null;
}

export function stop() {
  current?.pause();
  current = null;
  window.speechSynthesis?.cancel();
}

async function playUrl(url, rate = 1) {
  stop();
  const audio = new Audio(url);
  audio.playbackRate = rate;
  audio.preservesPitch = true; // медленно, но тем же голосом, без «баса»
  current = audio;
  try {
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

// Сервер ответил «голоса нет» (503) или не ответил — до этого момента не спрашиваем его снова,
// иначе каждое слово ждало бы сервер, прежде чем прозвучать запасным голосом
let serverSkipUntil = 0;

async function fromServer(text) {
  if (Date.now() < serverSkipUntil) return null;
  try {
    const res = await fetch(`${config.apiUrl}/tts?text=${encodeURIComponent(text)}`, {
      // Обычно ~0.5 с; дольше не ждём — слово должно прозвучать сразу
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 503) serverSkipUntil = Date.now() + 10 * 60_000; // голос на сервере не установлен
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    serverSkipUntil = Date.now() + 60_000; // сервер недоступен — не страшно
    return null;
  }
}

/**
 * Произносит текст.
 * @param {{rate?: number}} [opts] rate — скорость (0.7 — медленно, для тренажёра произношения)
 * @returns {Promise<'file'|'server'|'browser'|null>} откуда взялся голос (null — голоса нет)
 */
export async function speak(text, { rate = 1 } = {}) {
  if (!text?.trim()) return null;
  const key = normalize(text);

  const index = await loadIndex();
  const file = index?.files?.[key];
  if (file && (await playUrl(`${base}audio/tts/${file}`, rate))) return 'file';

  const url = await fromServer(text);
  if (url && (await playUrl(url, rate))) return 'server';

  const found = await browserVoice();
  if (found) {
    stop();
    const utterance = new SpeechSynthesisUtterance(found.tajik ? text : forRussianVoice(text));
    utterance.voice = found.voice;
    utterance.lang = found.voice.lang;
    utterance.rate = 0.9 * rate; // чуть медленнее — понятнее
    currentUtterance = utterance;
    window.speechSynthesis.speak(utterance);
    return 'browser';
  }
  return null;
}

let currentUtterance = null;

/**
 * Произнести и дождаться конца — чтобы помощник в тренажёре говорил фразы по очереди.
 * @returns {Promise<'file'|'server'|'browser'|null>}
 */
export async function speakAndWait(text, opts) {
  const source = await speak(text, opts);
  if (source === 'browser') {
    const u = currentUtterance;
    await new Promise((resolve) => {
      if (!u || !window.speechSynthesis.speaking) return resolve();
      u.addEventListener('end', resolve, { once: true });
      u.addEventListener('error', resolve, { once: true });
    });
  } else if (source) {
    await waitEnd();
  }
  return source;
}

/** Длительность текущей записи в секундах (с учётом скорости) или null. */
export function currentDuration() {
  const audio = current;
  return audio && Number.isFinite(audio.duration) ? audio.duration / (audio.playbackRate || 1) : null;
}

/** Дождаться, пока текущая запись доиграет. */
function waitEnd() {
  const audio = current;
  if (!audio || audio.ended || audio.paused) return Promise.resolve();
  return new Promise((resolve) => {
    audio.addEventListener('ended', resolve, { once: true });
    audio.addEventListener('pause', resolve, { once: true });
  });
}

/**
 * Произносит предложение: готовым файлом целиком; иначе, если все слова озвучены, — по словам
 * таджикским голосом (работает и без интернета); иначе — как speak (сервер или голос браузера).
 */
export async function speakSentence(text, words) {
  const index = await loadIndex();
  // Вся фраза есть готовым файлом — лучше всего
  if (index?.files?.[normalize(text)]) return speak(text);
  // Все слова озвучены таджикским голосом — читаем ими, а не запасным русским голосом
  const allWords = words?.length && words.every((w) => index?.files?.[normalize(w)]);
  if (!allWords) return speak(text);
  let any = null;
  for (const word of words) {
    const file = index?.files?.[normalize(word)];
    if (file && (await playUrl(`${base}audio/tts/${file}`))) {
      any = 'file';
      await waitEnd();
    }
  }
  return any;
}

/** Заранее подгрузить список озвученных фраз (чтобы первое слово прозвучало без задержки). */
export function preloadSpeech() {
  loadIndex();
}
