// Фоновый поток новой нейросети (seqModel.js): страница присылает записи — поток отвечает
// вероятностями слов. Расчёт ~10 мс на запись, но не на странице — интерфейс не подтормаживает.
//
//   {type:'load', meta, weights}         → {type:'ready'} | {type:'error', message}
//   {type:'predict', id, clips: frames[]} → {type:'probs', id, probs: Float32Array[], ms}

import { SeqModel } from './seqModel.js';

let model = null;

self.onmessage = ({ data }) => {
  if (data.type === 'load') {
    try {
      model = new SeqModel(data.meta, data.weights);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message ?? err) });
    }
  } else if (data.type === 'predict') {
    const start = performance.now();
    const probs = data.clips.map((frames) => model.predict(frames));
    self.postMessage({ type: 'probs', id: data.id, probs, ms: performance.now() - start });
  }
};
