// Текст (таджикский или русский) → последовательность жестов для аватара.
//
// Ищем каждое слово в словаре жестов: по названию жеста, по основе слова (чтобы
// «мехоҳам», «мехоҳӣ» нашли жест «Хостан») и по русским словам. Слова, для которых
// жеста нет, остаются в субтитрах, но аватар их не показывает — честно, без выдумок.

// Жест → основы слов (таджикские и русские). Основа сравнивается с началом слова.
const STEMS = {
  Салом: ['салом', 'ассалом', 'привет', 'здравств'],
  Хайр: ['хайр', 'худо ҳофиз', 'пока', 'до свидан'],
  Ҳа: ['ҳа', 'бале', 'да'],
  Не: ['не', 'нест', 'на', 'нет'],
  Хуб: ['хуб', 'нағз', 'хорош', 'отличн'],
  Бад: ['бад', 'плох'],
  'Ёрӣ додан': ['ёрӣ', 'ёри', 'кумак', 'мадад', 'помо', 'помощ', 'помог'],
  Об: ['об', 'вода', 'воды', 'воду', 'пить'],
  'Дард мекунад': ['дард мекунад', 'дард', 'бемор', 'боли', 'больн', 'болит'],
  Модар: ['модар', 'оча', 'мама', 'мать', 'мамы'],
  Падар: ['падар', 'дада', 'папа', 'отец', 'отца'],
  Дӯст: ['дӯст', 'рафиқ', 'друг', 'подруг'],
  Ман: ['ман', 'маро', 'манро', 'я', 'мне', 'меня'],
  Ту: ['ту', 'туро', 'шумо', 'ты', 'тебе', 'тебя', 'вы', 'вам'],
  Мо: ['мо', 'моро', 'мы', 'нам', 'нас'],
  Хона: ['хона', 'дом'],
  Мактаб: ['мактаб', 'школ'],
  Миннатдорӣ: ['ташаккур', 'раҳмат', 'миннатдор', 'спасибо', 'благодар'],
  Чӣ: ['чӣ', 'чи', 'что', 'чего'],
  Чаро: ['чаро', 'барои чӣ', 'почему', 'зачем'],
  Хостан: ['мехоҳ', 'хоҳ', 'хост', 'хочу', 'хочешь', 'хотеть', 'хочет', 'хотим'],
  Фаҳмидан: ['фаҳм', 'понял', 'понима', 'понять'],
  Имрӯз: ['имрӯз', 'сегодня'],
  Фардо: ['фардо', 'завтра'],
  Хӯрок: ['хӯрок', 'хурок', 'хӯр', 'еда', 'есть', 'кушать', 'поесть'],
};

// Короткие основы (≤ 2 букв) совпадают только со словом целиком: иначе «на» нашлось бы в «нағз»
const WHOLE_WORD_MAX = 2;

const normalize = (s) =>
  s
    .toLowerCase()
    .replace(/[«»"“”„.,!?;:()…\-—–]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * @param {string} text
 * @param {Set<string>} available жесты, для которых есть запись движения
 * @returns {{word: string, label: string|null}[]}
 */
export function textToSigns(text, available) {
  const words = normalize(text).split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    // Сначала пробуем пары слов («худо ҳофиз», «барои чӣ», «дард мекунад»)
    const pair = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : null;
    const pairLabel = pair && findLabel(pair, available, true);
    if (pairLabel) {
      out.push({ word: `${words[i]} ${words[i + 1]}`, label: pairLabel });
      i++;
      continue;
    }
    out.push({ word: words[i], label: findLabel(words[i], available, false) });
  }
  return out;
}

function findLabel(word, available, pairOnly) {
  let best = null;
  let bestLen = 0;
  for (const [label, stems] of Object.entries(STEMS)) {
    if (!available.has(label)) continue;
    for (const stem of stems) {
      const isPair = stem.includes(' ');
      if (pairOnly !== isPair) continue;
      const match = stem.length <= WHOLE_WORD_MAX ? word === stem : word === stem || word.startsWith(stem);
      if (match && stem.length > bestLen) {
        best = label;
        bestLen = stem.length;
      }
    }
  }
  // Название жеста целиком (жесты, записанные пользователем, тоже находятся)
  if (!best && !pairOnly) {
    for (const label of available) if (normalize(label) === word) best = label;
  }
  return best;
}
