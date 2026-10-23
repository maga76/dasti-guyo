// Отправка записанных примеров на сервер.
// Если нет интернета или пользователь не вошёл — примеры копятся в браузере
// (флаг synced = false) и уходят позже: после входа, при появлении сети или по кнопке.

import { api, getToken, isAdmin } from './api.js';
import { db } from '../dataset/db.js';
import { NONE_LABEL } from '../dataset/dataset.js';

let running = null;

/**
 * @returns {Promise<{sent: number, waiting: number, missing: string[], loggedIn: boolean, error?: string}>}
 *   missing — жесты, которых нет на сервере (создать их может только администратор)
 */
export function syncSamples() {
  running ??= doSync().finally(() => (running = null));
  return running;
}

async function doSync() {
  const pending = (await db.getAllSamples()).filter((s) => !s.synced);
  const result = { sent: 0, waiting: pending.length, missing: [], loggedIn: Boolean(getToken()) };
  if (!pending.length || !result.loggedIn || !navigator.onLine) return result;

  try {
    const gestures = await api('/gestures?include_inactive=true');
    const byName = new Map(gestures.map((g) => [g.name_tj.trim().toLowerCase(), g.id]));
    const noneId = gestures.find((g) => g.category === 'system')?.id;
    const missing = new Set();

    for (const sample of pending) {
      let id = sample.label === NONE_LABEL ? noneId : byName.get(sample.label.trim().toLowerCase());
      if (!id && isAdmin() && sample.label !== NONE_LABEL) {
        // Администратор может сразу добавить новый жест в словарь
        const created = await api('/gestures', { method: 'POST', body: { name_tj: sample.label.trim() } });
        id = created.id;
        byName.set(sample.label.trim().toLowerCase(), id);
      }
      if (!id) {
        missing.add(sample.label);
        continue;
      }
      await api('/samples', {
        method: 'POST',
        body: {
          gesture_id: id,
          landmarks: sample.frames.map((f) => Array.from(f, (v) => Math.round(v * 1e4) / 1e4)),
          hand_count: sample.handCount ?? 1,
        },
      });
      await db.putSample({ ...sample, synced: true });
      result.sent++;
      result.waiting--;
    }
    result.missing = [...missing];
  } catch (err) {
    result.error = err.message;
  }
  return result;
}
