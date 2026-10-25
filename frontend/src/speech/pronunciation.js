// Оценка произношения в тренажёре «Талаффуз».
//
// Таджикскую речь браузеры почти не распознают, поэтому слушаем русским распознавателем:
// он записывает услышанное кириллицей, близкой к таджикской. Сравниваем с правильным словом
// «по звучанию»: особые таджикские буквы заменяем близкими (ҳ→х, қ→к, ҷ→дж …), похожие звуки
// (а/о, и/е, д/т …) считаем почти совпадающими. Оценка 0…1 = 1 − (цена правок) / (длина слова).
// Заодно находим, какие буквы правильного слова не получились, — их подсвечиваем и подсказываем.

// Таджикская буква → как её запишет русский распознаватель
const TAJIK = { ӣ: 'и', ӯ: 'у', ҳ: 'х', қ: 'к', ғ: 'г', ҷ: 'дж', ё: 'е' };
export const SPECIAL = ['ҳ', 'қ', 'ғ', 'ҷ', 'ӯ', 'ӣ'];

// Почти одинаковые звуки — замена стоит дёшево
const NEAR = [
  ['а', 'о', 0.3],
  ['и', 'е', 0.3],
  ['и', 'ы', 0.3],
  ['у', 'ю', 0.3],
  ['е', 'э', 0.2],
  ['д', 'т', 0.4],
  ['б', 'п', 0.4],
  ['з', 'с', 0.4],
  ['в', 'ф', 0.4],
  ['ж', 'ш', 0.4],
  ['г', 'к', 0.5],
  ['х', 'к', 0.6],
];
const nearCost = new Map();
for (const [a, b, cost] of NEAR) {
  nearCost.set(a + b, cost);
  nearCost.set(b + a, cost);
}
const subCost = (a, b) => (a === b ? 0 : (nearCost.get(a + b) ?? 1));

/**
 * Слово → звуки для сравнения и для каждого звука — номер буквы в исходном слове.
 * Не-буквы (пробелы, знаки) пропускаются, ь/ъ не звучат, двойные буквы — как одна.
 * @returns {{chars: string[], origin: number[]}}
 */
export function toSounds(text) {
  const chars = [];
  const origin = [];
  [...text.toLowerCase()].forEach((ch, i) => {
    if (!/\p{L}/u.test(ch) || ch === 'ь' || ch === 'ъ') return;
    for (const c of TAJIK[ch] ?? ch) {
      if (chars.at(-1) === c) continue; // «кк» → «к»
      chars.push(c);
      origin.push(i);
    }
  });
  return { chars, origin };
}

/**
 * Насколько услышанное похоже на правильное слово.
 * @param {string} target правильное слово (как в speech-words.json)
 * @param {string} heard что услышал распознаватель
 * @returns {{score: number, wrong: Set<number>}} wrong — номера букв target, которые не получились
 */
export function compare(target, heard) {
  const t = toSounds(target);
  const h = toSounds(heard).chars;
  const n = t.chars.length;
  const m = h.length;
  if (!n) return { score: 0, wrong: new Set() };
  // Расстояние Левенштейна с весами и восстановлением пути
  const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + subCost(t.chars[i - 1], h[j - 1]));
    }
  }
  const wrong = new Set();
  let i = n;
  let j = m;
  while (i > 0) {
    if (j > 0 && d[i][j] === d[i - 1][j - 1] + subCost(t.chars[i - 1], h[j - 1])) {
      // Почти совпало (а/о, д/т) — не ошибка; заметная замена — ошибка
      if (subCost(t.chars[i - 1], h[j - 1]) >= 0.5) wrong.add(t.origin[i - 1]);
      i--;
      j--;
    } else if (j > 0 && d[i][j] === d[i][j - 1] + 1) {
      j--; // лишний звук в услышанном
    } else {
      wrong.add(t.origin[i - 1]); // звук пропущен
      i--;
    }
  }
  const score = Math.max(0, 1 - d[n][m] / Math.max(n, m));
  return { score: Math.round(score * 1000) / 1000, wrong };
}

/** Лучшее из нескольких вариантов распознавания. */
export function bestMatch(target, heardVariants) {
  let best = { score: 0, wrong: new Set(toSounds(target).origin), heard: '' };
  for (const heard of heardVariants) {
    if (!heard?.trim()) continue;
    const r = compare(target, heard);
    if (r.score > best.score) best = { ...r, heard: heard.trim() };
  }
  return best;
}

/**
 * Слоги, в которых есть ошибочные буквы.
 * @param {string} text слово
 * @param {string[]} syllables слоги (их буквы по порядку = буквы слова)
 * @param {Set<number>} wrong номера ошибочных букв в text
 * @returns {boolean[]} для каждого слога — есть ли в нём ошибка
 */
export function wrongSyllables(text, syllables, wrong) {
  // Номера букв (без пробелов и знаков) в исходном тексте
  const letters = [];
  [...text].forEach((ch, i) => /\p{L}/u.test(ch) && letters.push(i));
  let k = 0;
  return syllables.map((syl) => {
    let bad = false;
    for (const ch of syl) {
      if (!/\p{L}/u.test(ch)) continue;
      if (wrong.has(letters[k])) bad = true;
      k++;
    }
    return bad;
  });
}

/** Особые таджикские буквы среди ошибочных — по ним даём подсказки. */
export function specialMistakes(text, wrong) {
  const found = [];
  [...text.toLowerCase()].forEach((ch, i) => {
    if (wrong.has(i) && SPECIAL.includes(ch) && !found.includes(ch)) found.push(ch);
  });
  return found;
}
