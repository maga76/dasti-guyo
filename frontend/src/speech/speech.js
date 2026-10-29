// Озвучка по-таджикски. Два голоса на выбор (кнопка в «Талаффуз», запоминается):
//   «Мадина» (по умолчанию) — женский нейросетевой голос Microsoft uz-UZ-MadinaNeural; таджикский
//     текст читается через узбекскую латиницу (узбекское произношение очень близко) — public/audio/madina;
//   «MMS» — нейросеть Meta MMS-TTS, обученная на таджикском, мужской голос — public/audio/tts.
// Источники по порядку:
//   1) заранее озвученные файлы выбранного голоса — работают без интернета;
//   2) сервер /tts?voice=… — тот же голос для новых фраз (свои слова из «Омӯзиш»);
//   3) голос браузера: таджикский, если есть (редко); узбекский (в Edge — та же «Мадина») —
//      через латиницу; иначе русский, особые буквы заменяются близкими (ӣ→и, ҳ→х …);
//   4) ничего — тогда сайт просто показывает текст.

import { config } from '../config.js';
import { assetUrls, download, downloadJson } from '../net/download.js';

const base = import.meta.env.BASE_URL;
const VOICE_KEY = 'dasti-guyo:voice';
export const VOICES = ['madina', 'mms'];
const VOICE_DIRS = { madina: 'audio/madina', mms: 'audio/tts' };
const indexPromises = {};
let current = null; // текущий HTMLAudioElement

/** Выбранный голос: 'madina' | 'mms'. */
export function getVoice() {
  try {
    const v = localStorage.getItem(VOICE_KEY);
    return VOICES.includes(v) ? v : 'madina';
  } catch {
    return 'madina';
  }
}

export function setVoice(voice) {
  try {
    localStorage.setItem(VOICE_KEY, voice);
  } catch {
    /* выбор просто не запомнится */
  }
}

/** Такой же вид текста, как на сервере (app/services/tts.py → normalize). */
export const normalize = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ');

// Файлы голоса берутся с быстрого CDN (как модели, net/download.js) и хранятся в браузере:
// со своего сервера на медленном интернете каждое слово начинало звучать через секунды
function loadIndex(voice = getVoice()) {
  indexPromises[voice] ??= downloadJson(assetUrls(`${VOICE_DIRS[voice]}/index.json`)).catch(() => {
    delete indexPromises[voice]; // попробуем ещё раз при следующем слове
    return null;
  });
  return indexPromises[voice];
}

/** Путь готового файла (от public/) для текста в выбранном голосе или null. */
async function filePath(text, voice = getVoice()) {
  const file = (await loadIndex(voice))?.files?.[normalize(text)];
  return file ? `${VOICE_DIRS[voice]}/${file}` : null;
}

const blobUrls = new Map(); // путь файла → Promise<blob-адрес>

/** Файл голоса → адрес для воспроизведения (скачивается один раз). */
function audioUrl(path) {
  if (!blobUrls.has(path)) {
    const type = path.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
    const promise = download(assetUrls(path)).then((buf) => URL.createObjectURL(new Blob([buf], { type })));
    promise.catch(() => blobUrls.delete(path));
    blobUrls.set(path, promise);
  }
  return blobUrls.get(path);
}

/** Адрес готового файла для текста или null. */
async function fileUrl(text, voice = getVoice()) {
  const path = await filePath(text, voice);
  if (!path) return null;
  return audioUrl(path).catch(() => `${base}${path}`);
}

/**
 * Заранее скачать голос для текстов (в фоне, по одному) — чтобы потом слова звучали сразу.
 * @param {string[]} texts
 */
export async function preloadVoice(texts) {
  for (const text of texts) {
    const path = await filePath(text).catch(() => null);
    if (path) await audioUrl(path).catch(() => null);
  }
}

// Буквы таджикского алфавита, которых нет в русском, → как их прочитает русский голос
const TAJIK_TO_RUSSIAN = { ӣ: 'и', Ӣ: 'И', ӯ: 'у', Ӯ: 'У', ҳ: 'х', Ҳ: 'Х', қ: 'к', Қ: 'К', ғ: 'г', Ғ: 'Г', ҷ: 'дж', Ҷ: 'Дж' };
export const forRussianVoice = (text) => text.replace(/[ӣӢӯӮҳҲқҚғҒҷҶ]/g, (c) => TAJIK_TO_RUSSIAN[c]);

// Таджикская кириллица → узбекская латиница (как на сервере, app/services/tajik_latin.py)
const LATIN = {
  а: 'a', б: 'b', в: 'v', г: 'g', ғ: 'gʻ', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', ӣ: 'i', й: 'y',
  к: 'k', қ: 'q', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ӯ: 'oʻ', ф: 'f',
  х: 'x', ҳ: 'h', ч: 'ch', ҷ: 'j', ш: 'sh', ъ: 'ʼ', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
const VOWELS = new Set('аеёиӣоуӯэюя');
export function toLatin(text) {
  let prev = '';
  let out = '';
  for (const ch of text) {
    const low = ch.toLowerCase();
    let lat = LATIN[low];
    if (lat === undefined) {
      out += ch;
    } else {
      // «е» в начале слова и после гласной звучит как «йе»
      if (low === 'е' && (!prev || !/\p{L}/u.test(prev) || VOWELS.has(prev.toLowerCase()))) lat = 'ye';
      out += ch !== low && lat ? lat[0].toUpperCase() + lat.slice(1) : lat;
    }
    prev = ch;
  }
  return out;
}

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

/** Голос браузера и как ему подать текст: {voice, prepare} или null. */
async function browserVoice() {
  const list = await voices();
  const lang = (v) => v.lang.toLowerCase();
  const tg = list.find((v) => lang(v).startsWith('tg'));
  if (tg) return { voice: tg, prepare: (text) => text };
  // Узбекский женский (в Edge — «Мадина») читает таджикский через латиницу почти как носитель
  const uz = list.filter((v) => lang(v).startsWith('uz'));
  const uzVoice = uz.find((v) => /madina/i.test(v.name)) ?? uz[0];
  if (uzVoice) return { voice: uzVoice, prepare: toLatin };
  // Русский: локальный лучше — работает без интернета и без задержки
  const ru = list.filter((v) => lang(v).startsWith('ru'));
  const voice = ru.find((v) => v.localService) ?? ru[0];
  return voice ? { voice, prepare: forRussianVoice } : null;
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
    const res = await fetch(`${config.apiUrl}/tts?voice=${getVoice()}&text=${encodeURIComponent(text)}`, {
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

  const file = await fileUrl(text);
  if (file && (await playUrl(file, rate))) return 'file';

  const url = await fromServer(text);
  if (url && (await playUrl(url, rate))) return 'server';

  const found = await browserVoice();
  if (found) {
    stop();
    const utterance = new SpeechSynthesisUtterance(found.prepare(text));
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
  // Подстраховка: если браузер так и не сообщит о конце речи, разговор не должен зависнуть
  const limit = new Promise((r) => setTimeout(r, 2000 + (text?.length ?? 0) * 150));
  if (source === 'browser') {
    const u = currentUtterance;
    const end = new Promise((resolve) => {
      if (!u || !window.speechSynthesis.speaking) return resolve();
      u.addEventListener('end', resolve, { once: true });
      u.addEventListener('error', resolve, { once: true });
    });
    await Promise.race([end, limit]);
  } else if (source) {
    await Promise.race([waitEnd(), limit]);
  }
  return source;
}

/** Звучит ли сейчас голос (запись или голос браузера) — для живого лица учителя. */
export function isSpeaking() {
  return Boolean((current && !current.paused && !current.ended) || window.speechSynthesis?.speaking);
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

/** Заранее подгрузить список озвученных фраз (чтобы первое слово прозвучало без задержки). */
export function preloadSpeech() {
  loadIndex();
}
