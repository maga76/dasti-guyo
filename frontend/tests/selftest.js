// Самопроверка без камеры: признаки (совпадение с Python), запись, базовая модель,
// обучение в браузере, экспорт/импорт.
// Хранит всё под отдельными ключами и удаляет за собой — данные пользователя не трогает.

import { FRAME, INPUT_SIZE, frameFromHands, mirror, sequenceFeatures } from '../src/dataset/features.js';
import { findWarnings } from '../src/dataset/dataset.js';
import { RecordError, Recorder } from '../src/dataset/recorder.js';
import { loadBaseDataset } from '../src/dataset/baseDataset.js';
import { GestureClassifier, loadTf } from '../src/model/classifier.js';

const out = document.getElementById('out');
let passed = 0;
let failed = 0;

async function check(name, fn) {
  const li = document.createElement('li');
  const started = performance.now();
  try {
    const detail = await fn();
    li.className = 'ok';
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    li.textContent = `✔ ${name}${detail ? ` — ${detail}` : ''} (${secs} с)`;
    passed++;
  } catch (err) {
    li.className = 'fail';
    li.textContent = `✘ ${name}: ${err.message}`;
    console.error(name, err);
    failed++;
  }
  out.append(li);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const maxDiff = (a, b) => Math.max(...Array.from(a, (v, i) => Math.abs(v - b[i])));

/** Рука для тестов: запястье (cx, cy), точка 9 на `size` выше. */
function fakeHand(cx = 0.5, cy = 0.6, size = 0.1) {
  const landmarks = Array.from({ length: 21 }, (_, i) => ({
    x: cx + ((i % 5) - 2) * size * 0.3,
    y: cy - (Math.floor(i / 4) + 1) * size * 0.4,
    z: -0.1 * size * i,
  }));
  landmarks[0] = { x: cx, y: cy, z: 0 };
  landmarks[9] = { x: cx, y: cy - size, z: 0 };
  return { side: 'right', score: 0.99, landmarks };
}

/** Синтетическая запись одной рукой: форма руки — «центр» класса с шумом. */
function fakeSample(center, n = 20) {
  return {
    frames: Array.from({ length: n }, () => {
      const f = new Array(FRAME).fill(0);
      for (let k = 0; k < 63; k++) f[k] = center + (Math.random() - 0.5) * 0.2;
      f[63] = (Math.random() - 0.5) * 0.02;
      f[64] = (Math.random() - 0.5) * 0.02;
      f[65] = 0.1;
      return f;
    }),
  };
}

await check('Признаки совпадают с сервером (Python)', async () => {
  const fx = await (await fetch('/tests/fixtures/features-v2.json')).json();
  const hands = fx.hands.map((hs) => hs.map((pts) => ({ landmarks: pts.map(([x, y, z]) => ({ x, y, z })) })));
  const frames = hands.map((hs) => frameFromHands(hs, fx.aspect));
  const frameDiff = Math.max(...frames.map((f, i) => maxDiff(f, fx.frames[i])));
  assert(frameDiff < 1e-5, `кадры отличаются на ${frameDiff}`);
  const seqDiff = maxDiff(sequenceFeatures(frames), fx.sequence);
  assert(seqDiff < 1e-4, `последовательность отличается на ${seqDiff}`);
  return `макс. разница ${seqDiff.toExponential(1)}`;
});

await check('Главная рука — левее в кадре, порядок от MediaPipe не важен', () => {
  const a = frameFromHands([fakeHand(0.7), fakeHand(0.3)], 1);
  const b = frameFromHands([fakeHand(0.3), fakeHand(0.7)], 1);
  assert(maxDiff(a, b) === 0, 'порядок рук влияет на признаки');
  assert(Math.abs(a[63] + 0.2) < 1e-9, `запястье главной руки: ${a[63]}`);
});

await check('Зеркало дважды = исходная запись', () => {
  const frames = [frameFromHands([fakeHand()], 4 / 3), frameFromHands([fakeHand(0.3), fakeHand(0.7)], 4 / 3)];
  const back = mirror(mirror(frames));
  assert(Math.max(...frames.map((f, i) => maxDiff(f, back[i]))) < 1e-12, 'не совпало');
  assert(mirror(frames)[0].slice(66).every((v) => v === 0), 'у отсутствующей руки появились числа');
});

await check('Предупреждения: мало примеров, нет «нет жеста», похожие жесты', () => {
  const group = (label, center, n) => ({ label, samples: Array.from({ length: n }, () => fakeSample(center)) });
  const w = findWarnings([group('Салом', 0, 5), group('Об', 0, 25), group('Нон', 3, 25)]);
  assert(w.some((x) => x.type === 'noNone'), 'нет предупреждения noNone');
  assert(w.some((x) => x.type === 'few' && x.label === 'Салом'), 'нет предупреждения few');
  assert(w.some((x) => x.type === 'similar' && [x.a, x.b].includes('Об')), 'нет предупреждения similar');
  assert(!w.some((x) => x.type === 'similar' && [x.a, x.b].includes('Нон')), 'лишнее similar для «Нон»');
});

await check('Запись: отсчёт 3 с, затем сбор кадров по 132 числа', async () => {
  const rec = new Recorder(() => 4 / 3);
  const counts = [];
  const promise = rec.record({ target: 25, onCountdown: (n) => counts.push(n) });
  rec.feed([fakeHand()]); // во время отсчёта кадры не пишутся
  await new Promise((r) => setTimeout(r, 3100));
  for (let i = 0; i < 40; i++) rec.feed(i % 3 ? [fakeHand()] : []); // кадры без рук пропускаются
  const result = await promise;
  assert(counts.join() === '3,2,1,0', `отсчёт ${counts}`);
  assert(result.frames.length === 25 && result.frames[0].length === FRAME, 'неверный размер записи');
});

await check('Запись: отмена', async () => {
  const rec = new Recorder(() => 1);
  const promise = rec.record({ target: 25 });
  rec.cancel();
  try {
    await promise;
    throw new Error('должна быть ошибка');
  } catch (err) {
    assert(err instanceof RecordError && err.code === 'cancelled', err.message);
  }
});

await check('Базовая модель из Python работает в браузере так же, как в Python', async () => {
  // Итоговая базовая модель обучена на ВСЕХ записях Slovo, поэтому здесь проверяется
  // только перенос Python → TensorFlow.js (должна узнавать почти все записи).
  // Честная точность на новых людях считается при сборке отдельно (metrics.json).
  const base = new GestureClassifier({ modelUrl: 'indexeddb://selftest-none', metaKey: 'selftest-none' });
  assert(await base.loadBase(), 'базовая модель не загрузилась');
  const data = await loadBaseDataset();
  const correct = data.samples.filter((s) => base.predict(s.frames).label === s.label).length;
  const acc = correct / data.samples.length;
  assert(acc > 0.9, `узнано только ${Math.round(acc * 100)}% записей`);
  return `${base.meta.labels.length} жестов, узнано ${correct} из ${data.samples.length}; на новых людях — ${Math.round(base.meta.accuracy * 1000) / 10}%`;
});

const classifier = new GestureClassifier({ modelUrl: 'indexeddb://selftest-a', metaKey: 'selftest-a' });
const ownGroups = [
  { label: '__none__', samples: Array.from({ length: 6 }, () => fakeSample(0)) },
  { label: 'Тест-А', samples: Array.from({ length: 6 }, () => fakeSample(1)) },
  { label: 'Тест-Б', samples: Array.from({ length: 6 }, () => fakeSample(-1)) },
];

await check('Обучение в браузере на своих записях', async () => {
  const tf = await loadTf();
  let epochs = 0;
  const meta = await classifier.train(ownGroups, { useBase: false, onEpoch: ({ epoch }) => (epochs = epoch) });
  assert(meta.validated && meta.accuracy > 0.9, `точность ${meta.accuracy}`);
  assert(meta.curve.length === epochs && meta.curve[0].test != null, 'нет кривой обучения');
  assert(classifier.predict(fakeSample(1).frames).label === 'Тест-А', 'ответ неверный');
  return `бэкенд ${tf.getBackend()}, точность ${Math.round(meta.accuracy * 100)}%`;
});

await check('Обучение в браузере вместе с набором Slovo', async () => {
  const meta = await classifier.train(ownGroups, { useBase: true });
  assert(meta.usedBase, 'Slovo не использован');
  assert(meta.labels.includes('Салом') && meta.labels.includes('Тест-А'), 'не все жесты в модели');
  assert(classifier.predict(fakeSample(-1).frames).label === 'Тест-Б', 'свой жест не узнан');
  return `${meta.labels.length} жестов, точность ${Math.round(meta.accuracy * 100)}%`;
});

await check('Сохранение в IndexedDB и загрузка', async () => {
  const again = new GestureClassifier({ modelUrl: 'indexeddb://selftest-a', metaKey: 'selftest-a' });
  assert(await again.loadLocal(), 'модель не загрузилась');
  assert(again.meta.source === 'local', 'загружена не своя модель');
  assert(again.predict(fakeSample(1).frames).label === 'Тест-А', 'ответ после загрузки другой');
});

await check('Экспорт → импорт модели даёт те же ответы', async () => {
  const exported = JSON.parse(JSON.stringify(await classifier.exportModel())); // как через файл
  const copy = new GestureClassifier({ modelUrl: 'indexeddb://selftest-b', metaKey: 'selftest-b' });
  await copy.importModel(exported);
  const frames = fakeSample(0.5).frames;
  const diff = maxDiff(classifier.predict(frames).probs, copy.predict(frames).probs);
  assert(diff < 1e-6, `разница ${diff}`);
  await copy.clear();
});

await check('Сборка предложений по правилам', async () => {
  const rules = [
    { words: ['Ман', 'Об', 'Хостан'], text_tj: 'Ман об мехоҳам', text_ru: 'Я хочу пить' },
    { words: ['Ман', 'Фаҳмидан'], text_tj: 'Ман фаҳмидам', text_ru: 'Я понял' },
  ];
  const { buildSentence, loadDictionary } = await import('../src/dataset/dictionary.js');
  const a = buildSentence(['Ман', 'Об', 'Хостан'], rules);
  assert(a.tj === 'Ман об мехоҳам' && a.ru === 'Я хочу пить' && a.matched, JSON.stringify(a));
  const b = buildSentence(['Салом', 'Ман', 'Фаҳмидан'], rules); // правило в середине
  assert(b.tj === 'Салом Ман фаҳмидам', b.tj);
  const c = buildSentence(['ман', 'об'], rules); // правило не полностью — слова как есть
  assert(c.tj === 'Ман об' && !c.matched, c.tj);
  const dict = await loadDictionary();
  assert(dict.phrases.length > 5 && dict.quickPhrases.length > 5, 'словарь не загрузился');
  return `правил в словаре: ${dict.phrases.length}, быстрых фраз: ${dict.quickPhrases.length}`;
});

await check('Текст → жесты для аватара (формы слов, русский, пары слов)', async () => {
  const { textToSigns } = await import('../src/avatar/lexicon.js');
  const known = new Set(['Ман', 'Об', 'Хостан', 'Миннатдорӣ', 'Хуб', 'Салом', 'Дард мекунад', 'Не', 'Хайр']);
  const labels = (text) => textToSigns(text, known).map((x) => x.label ?? '—').join(' ');
  const cases = [
    ['Ман об мехоҳам', 'Ман Об Хостан'],
    ['Ташаккур, нағз!', 'Миннатдорӣ Хуб'], // «нағз» не должно стать «Не» из-за основы «на»
    ['Привет, я хочу пить', 'Салом Ман Хостан Об'],
    ['Дард мекунад', 'Дард мекунад'], // пара слов — один жест
    ['Худо ҳофиз', 'Хайр'],
    ['Компютер', '—'], // неизвестное слово — без жеста
  ];
  for (const [text, expected] of cases) assert(labels(text) === expected, `«${text}» → ${labels(text)}`);
  return `${cases.length} фраз`;
});

await check('Вход модели — 2112 чисел', () => {
  assert(sequenceFeatures(fakeSample(0, 7).frames).length === INPUT_SIZE, 'неверный размер');
});

await classifier.clear();

const summary = document.getElementById('summary');
summary.textContent = failed ? `ОШИБКИ: ${failed}, успешно: ${passed}` : `Все проверки пройдены: ${passed}`;
summary.className = failed ? 'fail' : 'ok';
document.title = failed ? `SELFTEST FAIL ${failed}` : `SELFTEST PASS ${passed}`;
