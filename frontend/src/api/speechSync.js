// Попытки тренажёра произношения «Талаффуз» → профиль на сервере.
// Без входа или без сети попытки ждут в браузере и уходят позже (как итоги тренажёра жестов).

import { api, getToken } from './api.js';

const QUEUE_KEY = 'dasti-guyo:speechQueue';
const MAX_QUEUE = 200;

function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)));
  } catch {
    /* не сохранилось — попытка просто не попадёт в профиль */
  }
}

let running = null;

/** Поставить попытку {word, score, heard} в очередь и попробовать отправить. */
export function saveSpeech(attempt) {
  writeQueue([...readQueue(), attempt]);
  return flushSpeech();
}

/** Отправить всё, что ждёт. true — очередь пуста. */
export function flushSpeech() {
  running ??= (async () => {
    let queue = readQueue();
    if (!queue.length) return true;
    if (!getToken() || !navigator.onLine) return false;
    try {
      while (queue.length) {
        await api('/me/speech', { method: 'POST', body: queue[0] });
        queue = queue.slice(1);
        writeQueue(queue);
      }
      return true;
    } catch (err) {
      // Неверные данные сервер не примет и потом — выбрасываем, чтобы не застряла вся очередь
      if (err.status === 422) writeQueue(queue.slice(1));
      return false;
    }
  })().finally(() => (running = null));
  return running;
}
