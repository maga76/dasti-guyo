// Озвучка по-таджикски. Источники по порядку:
//   1) заранее озвученные файлы нейросети MMS-TTS (public/audio/tts) — работают без интернета;
//   2) сервер /tts — та же нейросеть для новых фраз (если сервер доступен);
//   3) голос браузера, если в системе есть таджикский (бывает редко);
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

/** Таджикский голос браузера, если он есть. */
function browserVoice() {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  return voices.find((v) => v.lang.toLowerCase().startsWith('tg')) ?? null;
}

export function stop() {
  current?.pause();
  current = null;
  window.speechSynthesis?.cancel();
}

async function playUrl(url) {
  stop();
  const audio = new Audio(url);
  current = audio;
  try {
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

async function fromServer(text) {
  try {
    const res = await fetch(`${config.apiUrl}/tts?text=${encodeURIComponent(text)}`, {
      // Обычно ~0.5 с, но сразу после запуска сервера модель голоса ещё может загружаться
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null; // сервер недоступен — не страшно
  }
}

/**
 * Произносит текст.
 * @returns {Promise<'file'|'server'|'browser'|null>} откуда взялся голос (null — голоса нет)
 */
export async function speak(text) {
  if (!text?.trim()) return null;
  const key = normalize(text);

  const index = await loadIndex();
  const file = index?.files?.[key];
  if (file && (await playUrl(`${base}audio/tts/${file}`))) return 'file';

  const url = await fromServer(text);
  if (url && (await playUrl(url))) return 'server';

  const voice = browserVoice();
  if (voice) {
    stop();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    window.speechSynthesis.speak(utterance);
    return 'browser';
  }
  return null;
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
 * Произносит предложение. Если целиком его озвучить нечем (нет файла и сервера),
 * произносит слова по одному из готовых файлов — так голос есть и без интернета.
 */
export async function speakSentence(text, words) {
  const source = await speak(text);
  if (source || !words?.length) return source;
  const index = await loadIndex();
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
