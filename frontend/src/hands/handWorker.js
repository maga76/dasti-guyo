// Фоновый поток распознавания рук. Страница присылает кадр (ImageBitmap), поток находит руки
// и отвечает — а страница тем временем свободна: кнопки, анимации и аватар не подтормаживают.
//
// Сообщения от страницы:
//   {type:'init', fileset, model}   → {type:'ready', delegate} | {type:'error', message}
//   {type:'pose', fileset, buffer}  → (ответа нет; без позы просто не отсеиваются руки по телу)
//   {type:'detect', id, bitmap, timestamp, aspect} → {type:'hands', id, hands, ms} | {type:'hands', id, error}
//   {type:'reset'}                  — новая серия кадров

import { HandCore } from './handCore.js';

const core = new HandCore();

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const delegate = await core.create(data.fileset, new Uint8Array(data.model));
      self.postMessage({ type: 'ready', delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message ?? err) });
    }
  } else if (data.type === 'pose') {
    try {
      await core.createPose(data.fileset, data.buffer);
    } catch (err) {
      console.warn('[hands] Поза тела не загрузилась — ложные руки отсеиваются без неё:', err);
    }
  } else if (data.type === 'detect') {
    const start = performance.now();
    try {
      const hands = core.detect(data.bitmap, data.timestamp, data.aspect);
      self.postMessage({ type: 'hands', id: data.id, hands, ms: performance.now() - start });
    } catch (err) {
      self.postMessage({ type: 'hands', id: data.id, error: String(err?.message ?? err) });
    } finally {
      data.bitmap.close();
    }
  } else if (data.type === 'reset') {
    core.reset();
  }
};
