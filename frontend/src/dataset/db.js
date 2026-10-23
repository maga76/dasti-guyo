// Маленькая обёртка над IndexedDB: всё хранится в браузере и работает без интернета.
//
// Хранилища:
//   samples — записи жестов {id, uid, label, frames, handCount, createdAt, synced}
//   meta    — служебные данные по ключу (метаданные модели и т.п.)
// Сама модель TensorFlow.js хранится отдельно — через tf.io ('indexeddb://...').

const DB_NAME = 'dasti-guyo';
// Версия 2: кадр стал 132 числа (модель видит движение). Старые записи несовместимы.
const DB_VERSION = 2;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('samples')) {
        const store = db.createObjectStore('samples', { keyPath: 'id', autoIncrement: true });
        store.createIndex('label', 'label');
        store.createIndex('uid', 'uid', { unique: true });
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');

      // С версии 1: записи из 126 чисел и старая модель больше не подходят
      if (event.oldVersion === 1) {
        req.transaction.objectStore('samples').clear();
        req.transaction.objectStore('meta').delete('localModel');
        req.transaction.objectStore('meta').delete('datasetChangedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Выполняет действие в транзакции и ждёт её завершения. */
async function tx(storeName, mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    const req = action(store);
    if (req) req.onsuccess = () => (result = req.result);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export const db = {
  addSample: (sample) => tx('samples', 'readwrite', (s) => s.add(sample)),
  putSample: (sample) => tx('samples', 'readwrite', (s) => s.put(sample)),
  getAllSamples: () => tx('samples', 'readonly', (s) => s.getAll()),
  deleteSample: (id) => tx('samples', 'readwrite', (s) => s.delete(id)),
  clearSamples: () => tx('samples', 'readwrite', (s) => s.clear()),

  /** Удаляет все записи одного жеста. */
  async deleteLabel(label) {
    const samples = await db.getAllSamples();
    const ids = samples.filter((s) => s.label === label).map((s) => s.id);
    await tx('samples', 'readwrite', (s) => {
      ids.forEach((id) => s.delete(id));
    });
  },

  getMeta: (key) => tx('meta', 'readonly', (s) => s.get(key)),
  setMeta: (key, value) => tx('meta', 'readwrite', (s) => s.put(value, key)),
  deleteMeta: (key) => tx('meta', 'readwrite', (s) => s.delete(key)),
};
