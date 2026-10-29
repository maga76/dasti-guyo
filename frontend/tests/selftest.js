// Самопроверка без камеры: признаки (совпадение с Python), запись, базовая модель,
// обучение в браузере, экспорт/импорт.
// Хранит всё под отдельными ключами и удаляет за собой — данные пользователя не трогает.

import { FRAME, INPUT_SIZE, frameFromHands, mirror, sequenceFeatures } from '../src/dataset/features.js';
import { findWarnings } from '../src/dataset/dataset.js';
import { RecordError, Recorder } from '../src/dataset/recorder.js';
import { loadBaseDataset } from '../src/dataset/baseDataset.js';
import { GestureClassifier, loadTf } from '../src/model/classifier.js';
import { MIN_MOTION, motionSpeed } from '../src/recognizer/recognizer.js';
import { compare, specialMistakes, wrongSyllables } from '../src/speech/pronunciation.js';

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

await check('Руки не обрываются: ведение по положению, удержание, сторона не скачет', async () => {
  const { HandCore } = await import('../src/hands/handCore.js');
  // Рука-«звезда» вокруг точки (cx, cy): пропорции как у настоящей кисти
  const hand = (cx, cy, side) => {
    const lm = Array.from({ length: 21 }, (_, i) => {
      const finger = Math.max(0, Math.ceil(i / 4) - 1);
      const along = i === 0 ? 0 : ((i - 1) % 4) + 1;
      return { x: cx + (finger - 2) * 0.012, y: cy + 0.05 - along * 0.022, z: 0 };
    });
    return { side, score: 0.9, landmarks: lm, world: [] };
  };
  const core = new HandCore();
  core.pose = {}; // «поза загружена» (сама поза — из подставных функций ниже)
  const noBody = () => null;
  const seen = (hands) => hands.map((h) => h.side).join(',') || '—';
  const run = (frames, body = noBody) => frames.map((f) => seen(core.track(f, 4 / 3, body)));

  // Новая рука — с третьего кадра; пропуск 1–2 кадров — держится; сторона не скачет
  const a = run([[hand(0.5, 0.5, 'right')], [hand(0.5, 0.5, 'right')], [hand(0.51, 0.5, 'right')], [], [hand(0.52, 0.5, 'left')], [], [], []]);
  assert(a.join(' ') === '— — right right right right right —', a.join(' '));

  // Тело далеко от новой «руки» (лицо, узор) — не засчитывается
  core.reset();
  const farBody = () => Array.from({ length: 33 }, () => ({ x: 0.1, y: 0.9, z: 0 }));
  const b = run([[hand(0.5, 0.3, 'right')], [hand(0.5, 0.3, 'right')], [hand(0.5, 0.3, 'right')]], farBody);
  assert(b.join(' ') === '— — —', b.join(' '));

  // Голова у поднятой руки: одно запястье подтверждает только одну кисть — ближайшую
  core.reset();
  const wristAt = (x, y) => () => {
    core.poseVersion = (core.poseVersion ?? 0) + 1;
    return Array.from({ length: 33 }, (_, i) => ([15, 17, 19, 21].includes(i) ? { x, y, z: 0 } : { x: 0.95, y: 0.95, z: 0 }));
  };
  const two = () => [hand(0.4, 0.5, 'right'), hand(0.43, 0.47, 'left')]; // рука у запястья и «голова» вплотную
  const c = run([two(), two(), two(), two()], wristAt(0.4, 0.55));
  assert(c.at(-1) === 'right', c.join(' '));

  // Голова, принятая за руку, пока человека не было видно, — убирается, когда тело видно
  core.reset();
  const d = run([[hand(0.5, 0.2, 'right')], [hand(0.5, 0.2, 'right')], [hand(0.5, 0.2, 'right')]]);
  const e = run([[hand(0.5, 0.2, 'right')], [hand(0.5, 0.2, 'right')], [hand(0.5, 0.2, 'right')]], wristAt(0.2, 0.9));
  assert(d.at(-1) === 'right' && e.join(' ') === 'right right —', `${d.join(' ')} / ${e.join(' ')}`);
  return 'появление, удержание, сторона, отсев по телу, голова у руки';
});

await check('Помощник предложения: глагол по лицу и времени, предлоги, вопрос', async () => {
  const { completeSentence } = await import('../src/dataset/grammar.js');
  const cases = [
    [['Ман', 'Об', 'Хостан'], 'Ман об мехоҳам.', 'Я хочу воду.'],
    [['Дирӯз', 'Ман', 'Мактаб', 'Рафтан'], 'Дирӯз ман ба мактаб рафтам.', 'Вчера я ходил в школу.'],
    [['Имрӯз', 'Мо', 'Футбол', 'Бозӣ кардан'], 'Имрӯз мо футбол бозӣ мекунем.', 'Сегодня мы играем в футбол.'],
    [['Ту', 'Чӣ', 'Хостан'], 'Ту чӣ мехоҳӣ?', 'Что ты хочешь?'],
    [['Ман', 'Не', 'Фаҳмидан'], 'Ман намефаҳмам.', 'Я не понимаю.'],
    [['Ту', 'Ман', 'Ёрӣ додан'], 'Ту ба ман ёрӣ медиҳӣ.', 'Ты помогаешь мне.'],
    [['Салом', 'Хона', 'Калон'], 'Салом! Хона калон аст.', 'Привет! Дом большой.'],
  ];
  for (const [words, tj, ru] of cases) {
    const r = completeSentence(words);
    assert(r.tj === tj && r.ru === ru, `${words.join(' ')} → ${r.tj} / ${r.ru}`);
  }
  return `${cases.length} предложений`;
});

await check('Текст → жесты для аватара (формы слов, русский, пары слов)', async () => {
  const { textToSigns } = await import('../src/avatar/lexicon.js');
  const known = new Set(['Ман', 'Об', 'Хостан', 'Миннатдорӣ', 'Хуб', 'Салом', 'Дард мекунад', 'Не', 'Хайр', 'Нӯшидан', 'Рафтан', 'Мактаб', 'Дирӯз']);
  const labels = (text) => textToSigns(text, known).map((x) => x.label ?? '—').join(' ');
  const cases = [
    ['Ман об мехоҳам', 'Ман Об Хостан'],
    ['Ташаккур, нағз!', 'Миннатдорӣ Хуб'], // «нағз» не должно стать «Не» из-за основы «на»
    ['Привет, я хочу пить', 'Салом Ман Хостан Нӯшидан'],
    ['Дирӯз ман ба мактаб рафтам', 'Дирӯз Ман — Мактаб Рафтан'], // «ба» — без жеста
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

await check('Талаффуз: оценка произношения и подсказки', async () => {
  // Русский распознаватель пишет таджикские слова по-своему — это должно засчитываться
  assert(compare('Салом', 'салам').score >= 0.75, 'салам ≈ Салом');
  assert(compare('Ташаккур', 'ташакур').score === 1, 'двойная буква');
  assert(compare('Ҷавоб', 'джавоб').score === 1, 'ҷ = дж');
  assert(compare('Модар', 'мама').score < 0.75, 'мама ≠ Модар');
  // Ошибка в «ҷ» подсвечивается и даёт подсказку по этой букве
  const r = compare('Ҷавоб', 'чавоб');
  assert(r.wrong.has(0) && !r.wrong.has(1), 'подсвечена не та буква');
  assert(specialMistakes('Ҷавоб', r.wrong).join() === 'ҷ', 'нет подсказки по ҷ');
  assert(wrongSyllables('Ҷавоб', ['Ҷа', 'воб'], r.wrong).join() === 'true,false', 'слог с ошибкой');
  const words = await (await fetch('../public/data/speech-words.json').catch(() => fetch('/data/speech-words.json'))).json();
  return `слов в тренажёре: ${words.words.length}, «чавоб» вместо «Ҷавоб» — ${Math.round(r.score * 100)}%`;
});

await check('Руки стоят — не жест, руки двигаются — жест', async () => {
  const { base, data } = await realSample();
  // Неподвижная рука с дрожанием камеры: тот же кадр + шум ~1% ладони, 30 кадров/с
  const still = Array.from({ length: 30 }, (_, k) => ({
    t: k * 33,
    frame: base.map((v, i) => (i % 66 < 63 ? v + (Math.random() - 0.5) * 0.02 : v)),
  }));
  const vStill = motionSpeed(still);
  // Настоящий жест из записи Slovo, растянутый на 1 с
  const moving = data.map((frame, k) => ({ t: (k * 1000) / data.length, frame }));
  const vMove = motionSpeed(moving);
  assert(vStill < MIN_MOTION, `неподвижная рука: ${vStill.toFixed(2)} ладони/с`);
  assert(vMove > MIN_MOTION, `жест: ${vMove.toFixed(2)} ладони/с`);
  return `неподвижно ${vStill.toFixed(2)}, жест ${vMove.toFixed(2)} ладони/с (порог ${MIN_MOTION})`;
});

/** Кадр и запись «Салом» из набора Slovo. */
async function realSample() {
  const set = await loadBaseDataset();
  const sample = set.samples.find((s) => s.label === 'Салом' && s.frames.every((f) => f[65] > 0));
  return { base: Array.from(sample.frames[0]), data: sample.frames };
}

await classifier.clear();

const summary = document.getElementById('summary');
summary.textContent = failed ? `ОШИБКИ: ${failed}, успешно: ${passed}` : `Все проверки пройдены: ${passed}`;
summary.className = failed ? 'fail' : 'ok';
document.title = failed ? `SELFTEST FAIL ${failed}` : `SELFTEST PASS ${passed}`;
