// Результаты тренажёра «Машқ» → профиль на сервере.
// Без входа или без сети игра ждёт в браузере и уходит позже (после входа, при появлении сети).

import { api, getToken } from './api.js';

const QUEUE_KEY = 'dasti-guyo:practiceQueue';
const MAX_QUEUE = 50;

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
    /* не сохранилось — игра просто не попадёт в профиль */
  }
}

let running = null;

/**
 * Поставить игру в очередь и попробовать отправить.
 * @param {{score: number, rounds: {label: string, ok: boolean}[]}} game
 * @returns {Promise<'saved'|'queued'>}
 */
export async function savePractice(game) {
  writeQueue([...readQueue(), game]);
  return (await flushPractice()) ? 'saved' : 'queued';
}

/** Отправить всё, что ждёт. true — очередь пуста. */
export function flushPractice() {
  running ??= (async () => {
    let queue = readQueue();
    if (!queue.length) return true;
    if (!getToken() || !navigator.onLine) return false;
    try {
      while (queue.length) {
        await api('/me/practice', { method: 'POST', body: queue[0] });
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
