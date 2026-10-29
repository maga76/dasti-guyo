// Помощник предложения: превращает цепочку распознанных жестов в правильное таджикское
// предложение (и его русский перевод).
//
// Жестовый язык не спрягает глаголы и не ставит предлоги: человек показывает «Ман · Об · Хостан»,
// а сказать нужно «Ман об мехоҳам.». Помощник:
//   - спрягает глагол по лицу (ман → -ам, ту → -ӣ, мо → -ем, «Модар» → -ад), время — по словам
//     «Дирӯз» (прошедшее) / «Имрӯз», «Фардо» (настоящее-будущее);
//   - «Не» рядом с глаголом → отрицание (намехоҳам);
//   - ставит порядок слов таджикского (время, кто, что, куда, глагол в конце) и русского;
//   - места: с «рафтан» — «ба мактаб» (в школу), с другими глаголами — «дар мактаб» (в школе);
//   - «Салом», «Ҳа», «Не» без глагола — отдельные короткие предложения;
//   - вопрос («Чӣ», «Чаро», «Кай», «Кӣ») — знак «?».
// Подлежащее «ман» без жеста не добавляется: в таджикском, как и в русском разговорном,
// «Об мехоҳам» / «Хочу воду» — нормально.
// Слова, которых помощник не знает (например, свои слова из «Омӯзиш»), остаются как есть.

const PERSONS = ['1sg', '2sg', '3sg', '1pl', '2pl', '3pl'];
const PRESENT_END = { '1sg': 'ам', '2sg': 'ӣ', '3sg': 'ад', '1pl': 'ем', '2pl': 'ед', '3pl': 'анд' };
const PAST_END = { '1sg': 'ам', '2sg': 'ӣ', '3sg': '', '1pl': 'ем', '2pl': 'ед', '3pl': 'анд' };

/** Русские формы: настоящее — 6 лиц, прошедшее — [м. ед., мн.]. */
const v = (pres, past, extra = {}) => ({ ruPres: pres.split(' '), ruPast: past.split(' '), ...extra });

// Глаголы: основа настоящего времени (pres), прошедшего (past), часть сложного глагола (prefix)
const VERBS = {
  хостан: { pres: 'хоҳ', past: 'хост', ...v('хочу хочешь хочет хотим хотите хотят', 'хотел хотели') },
  рафтан: { pres: 'рав', past: 'рафт', motion: true, ...v('иду идёшь идёт идём идёте идут', 'ходил ходили') },
  хӯрдан: { pres: 'хӯр', past: 'хӯрд', ...v('ем ешь ест едим едите едят', 'ел ели') },
  нӯшидан: { pres: 'нӯш', past: 'нӯшид', ...v('пью пьёшь пьёт пьём пьёте пьют', 'пил пили') },
  хобидан: { pres: 'хоб', past: 'хобид', ...v('сплю спишь спит спим спите спят', 'спал спали') },
  донистан: { pres: 'дон', past: 'донист', ...v('знаю знаешь знает знаем знаете знают', 'знал знали') },
  фаҳмидан: { pres: 'фаҳм', past: 'фаҳмид', ...v('понимаю понимаешь понимает понимаем понимаете понимают', 'понял поняли') },
  хондан: { pres: 'хон', past: 'хонд', ...v('читаю читаешь читает читаем читаете читают', 'читал читали') },
  навиштан: { pres: 'навис', past: 'навишт', ...v('пишу пишешь пишет пишем пишете пишут', 'писал писали') },
  харидан: { pres: 'хар', past: 'харид', ...v('покупаю покупаешь покупает покупаем покупаете покупают', 'купил купили') },
  'бозӣ кардан': { prefix: 'бозӣ', pres: 'кун', past: 'кард', ...v('играю играешь играет играем играете играют', 'играл играли') },
  'кор кардан': { prefix: 'кор', pres: 'кун', past: 'кард', ...v('работаю работаешь работает работаем работаете работают', 'работал работали') },
  'гап задан': { prefix: 'гап', pres: 'зан', past: 'зад', ...v('говорю говоришь говорит говорим говорите говорят', 'говорил говорили') },
  'дӯст доштан': { prefix: 'дӯст', pres: 'дор', past: 'дошт', ...v('люблю любишь любит любим любите любят', 'любил любили') },
  // Помогают кому: «ба ман ёрӣ медиҳад» / «помогает мне»
  'ёрӣ додан': { prefix: 'ёрӣ', pres: 'диҳ', past: 'дод', dative: true, ...v('помогаю помогаешь помогает помогаем помогаете помогают', 'помогал помогали') },
  // «Болит»: с подлежащим — «Ман дард дорам» (у меня боль), без него — «Дард мекунад»
  // («дорам» — без «ме»: у глагола «доштан» в значении «иметь» так говорят)
  'дард мекунад': { prefix: 'дард', pres: 'дор', past: 'дошт', pain: true, noMe: true, ...v('', '') },
};

const PRONOUNS = {
  ман: { person: '1sg', ru: 'я', ruAcc: 'меня', ruDat: 'мне', acc: 'маро' },
  ту: { person: '2sg', ru: 'ты', ruAcc: 'тебя', ruDat: 'тебе', acc: 'туро' },
  мо: { person: '1pl', ru: 'мы', ruAcc: 'нас', ruDat: 'нам', acc: 'моро' },
};

// Существительные: ru — именительный, acc — винительный, loc — «в/на ком-чём», to — «куда»,
// person — человек (может быть подлежащим, как дополнение получает «-ро»), g — род для прилагательного
const n = (ru, acc, extra = {}) => ({ ru, acc, ...extra });
const NOUNS = {
  об: n('вода', 'воду', { g: 'f' }),
  нон: n('хлеб', 'хлеб', { g: 'm' }),
  хӯрок: n('еда', 'еду', { g: 'f' }),
  пул: n('деньги', 'деньги', { g: 'pl' }),
  китоб: n('книга', 'книгу', { g: 'f' }),
  футбол: n('футбол', 'футбол', { g: 'm', game: true }),
  хона: n('дом', 'дом', { g: 'm', place: { to: 'домой', loc: 'дома' } }),
  мактаб: n('школа', 'школу', { g: 'f', place: { to: 'в школу', loc: 'в школе' } }),
  шаҳр: n('город', 'город', { g: 'm', place: { to: 'в город', loc: 'в городе' } }),
  мағоза: n('магазин', 'магазин', { g: 'm', place: { to: 'в магазин', loc: 'в магазине' } }),
  модар: n('мама', 'маму', { g: 'f', person: true, dat: 'маме' }),
  падар: n('папа', 'папу', { g: 'm', person: true, dat: 'папе' }),
  бародар: n('брат', 'брата', { g: 'm', person: true, dat: 'брату' }),
  хоҳар: n('сестра', 'сестру', { g: 'f', person: true, dat: 'сестре' }),
  дӯст: n('друг', 'друга', { g: 'm', person: true, dat: 'другу' }),
  оила: n('семья', 'семью', { g: 'f', person: true, dat: 'семье' }),
  писар: n('мальчик', 'мальчика', { g: 'm', person: true, dat: 'мальчику' }),
  духтар: n('девочка', 'девочку', { g: 'f', person: true, dat: 'девочке' }),
};

const TIME = {
  имрӯз: { ru: 'сегодня' },
  фардо: { ru: 'завтра' },
  дирӯз: { ru: 'вчера', past: true },
  саҳар: { ru: 'утром' },
  бегоҳ: { ru: 'вечером' },
};

const QUESTIONS = { чӣ: 'что', чаро: 'почему', кай: 'когда', кӣ: 'кто' };

// Прилагательные: русские формы по роду (м, ж, ср/мн) и винительный ж. р.
const ADJ = {
  хуб: { m: 'хороший', f: 'хорошая', pl: 'хорошие', fAcc: 'хорошую', state: 'хорошо' },
  бад: { m: 'плохой', f: 'плохая', pl: 'плохие', fAcc: 'плохую', state: 'плохо' },
  калон: { m: 'большой', f: 'большая', pl: 'большие', fAcc: 'большую' },
  хурд: { m: 'маленький', f: 'маленькая', pl: 'маленькие', fAcc: 'маленькую' },
};

// Отдельные короткие фразы
const STANDALONE = {
  салом: { tj: 'Салом!', ru: 'Привет!' },
  хайр: { tj: 'Хайр!', ru: 'Пока!' },
  ташаккур: { tj: 'Ташаккур!', ru: 'Спасибо!' },
  миннатдорӣ: { tj: 'Ташаккур!', ru: 'Спасибо!' },
  ҳа: { tj: 'Ҳа.', ru: 'Да.' },
};

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const key = (w) => w.trim().toLowerCase();

/** Изафет: «хона» + «калон» → «хонаи калон». */
const ezafe = (word) => `${word}и`;

/** Таджикская форма глагола. */
function tjVerb(verb, person, past, negative) {
  const stem = past ? `${verb.past}${PAST_END[person]}` : `${verb.noMe ? '' : 'ме'}${verb.pres}${PRESENT_END[person]}`;
  const form = negative ? `на${stem}` : stem;
  return verb.prefix ? `${verb.prefix} ${form}` : form;
}

/** Русская форма глагола. */
function ruVerb(verb, person, past, negative) {
  const plural = person.endsWith('pl');
  const form = past ? verb.ruPast[plural ? 1 : 0] : verb.ruPres[PERSONS.indexOf(person)];
  return negative ? `не ${form}` : form;
}

/** Русская форма прилагательного рядом с существительным. */
function ruAdj(adj, noun, accusative) {
  const g = noun?.g ?? 'm';
  if (g === 'pl') return adj.pl;
  if (g === 'f') return accusative ? adj.fAcc : adj.f;
  return adj.m;
}

/** Разбить слова на части-предложения: короткие фразы отдельно, каждый глагол закрывает часть. */
function clauses(words) {
  const parts = [];
  let current = [];
  const flush = () => {
    if (current.length) parts.push(current);
    current = [];
  };
  words.forEach((word, i) => {
    const k = key(word);
    // «Не» перед/после глагола — отрицание; одно «Не» — ответ «Нет.»
    const nearVerb = VERBS[key(words[i + 1] ?? '')] || VERBS[key(words[i - 1] ?? '')];
    if (STANDALONE[k] || (k === 'не' && !nearVerb)) {
      flush();
      parts.push([word]);
      return;
    }
    current.push(word);
    if (VERBS[k] && !(key(words[i + 1] ?? '') === 'не')) flush();
  });
  flush();
  return parts;
}

/** Одна часть предложения → {tj, ru}. */
function clause(words) {
  if (words.length === 1) {
    const k = key(words[0]);
    if (STANDALONE[k]) return STANDALONE[k];
    if (k === 'не') return { tj: 'Не.', ru: 'Нет.' };
  }

  let subject = null; // {tj, ru, person, ruDat}
  let verb = null;
  let negative = false;
  let question = null;
  const times = [];
  const objects = []; // {tj, ru}
  const places = []; // {noun, word}
  const adjectives = []; // прилагательные-сказуемые: «Ман хуб»
  let lastNoun = null; // для прилагательного: «Хона калон»
  // Без глагола прилагательное — сказуемое («Хона калон аст»), с глаголом — признак («китоби калон»)
  const hasVerb = words.some((w) => VERBS[key(w)]);

  for (const word of words) {
    const k = key(word);
    if (VERBS[k]) {
      verb = VERBS[k];
    } else if (k === 'не') {
      negative = true;
    } else if (QUESTIONS[k]) {
      question = { tj: k, ru: QUESTIONS[k] };
    } else if (TIME[k]) {
      times.push({ tj: k, ...TIME[k] });
    } else if (PRONOUNS[k]) {
      const p = PRONOUNS[k];
      if (!subject) subject = { tj: k, ru: p.ru, ruDat: p.ruDat, person: p.person };
      else objects.push({ tj: p.acc, ru: p.ruAcc, base: k, ruDat: p.ruDat });
      lastNoun = null;
    } else if (NOUNS[k]) {
      const noun = NOUNS[k];
      if (noun.place) {
        places.push({ noun, word: k });
        lastNoun = { noun, place: places.at(-1) };
      } else if (noun.person && !subject && !objects.length) {
        // Человек в начале — подлежащее: «Модар нон мехарад»
        subject = { tj: k, ru: noun.ru, ruDat: null, person: '3sg', noun };
        lastNoun = { noun, subject };
      } else {
        objects.push({ tj: noun.person ? `${k}ро` : k, ru: noun.acc, noun, base: k, ruDat: noun.dat });
        lastNoun = { noun, object: objects.at(-1) };
      }
    } else if (ADJ[k]) {
      const adj = ADJ[k];
      // Прилагательное после существительного — его признак («китоби калон»); иначе — сказуемое
      if (!hasVerb) {
        adjectives.push({ tj: k, adj, noun: lastNoun?.noun });
      } else if (lastNoun?.object) {
        lastNoun.object.tj = `${ezafe(lastNoun.object.tj)} ${k}`;
        lastNoun.object.ru = `${ruAdj(adj, lastNoun.noun, true)} ${lastNoun.object.ru}`;
      } else if (lastNoun?.place) {
        lastNoun.place.adj = { tj: k, adj };
      } else {
        adjectives.push({ tj: k, adj, noun: lastNoun?.noun });
      }
    } else {
      // Незнакомое слово (своё слово из «Омӯзиш») — как есть
      objects.push({ tj: k, ru: k });
      lastNoun = null;
    }
  }

  const past = times.some((t) => t.past);
  const person = subject?.person ?? '1sg';
  const tj = [];
  const ru = [];

  // --- Без глагола: «Ман хуб» → «Ман хуб ҳастам», «Хона калон» → «Хона калон аст» ---
  if (!verb) {
    const nounWord = places[0]?.word ?? objects[0]?.tj;
    const nounInfo = places[0]?.noun ?? objects[0]?.noun;
    const subjTj = subject?.tj ?? nounWord;
    tj.push(...times.map((t) => t.tj), subjTj, question?.tj, ...adjectives.map((a) => a.tj));
    if (adjectives.length || question) {
      const copula = subject?.person
        ? { '1sg': 'ҳастам', '2sg': 'ҳастӣ', '3sg': 'аст', '1pl': 'ҳастем' }[subject.person]
        : 'аст';
      tj.push(negative ? `не${copula === 'аст' ? 'ст' : copula.slice(1)}` : copula);
    }
    // Русский: «Мне хорошо», «Дом большой», «Кто ты?»
    if (question) ru.push(question.ru);
    ru.push(...times.map((t) => t.ru));
    const adjRu = adjectives.map((a) => {
      if (subject?.ruDat && a.adj.state) return null; // «мне хорошо» — ниже
      return ruAdj(a.adj, subject?.noun ?? nounInfo ?? a.noun, false);
    });
    if (subject?.ruDat && adjectives.some((a) => a.adj.state)) {
      ru.push(subject.ruDat, ...(negative ? ['не'] : []), ...adjectives.map((a) => a.adj.state));
    } else {
      ru.push(subject?.ru ?? nounInfo?.ru ?? nounWord, ...(negative ? ['не'] : []), ...adjRu.filter(Boolean));
    }
    return finish(tj, ru, question);
  }

  // --- «Болит» ---
  if (verb.pain) {
    if (subject) {
      tj.push(...times.map((t) => t.tj), subject.tj, tjVerb(verb, person, past, negative));
      ru.push(...times.map((t) => t.ru), subject.ruDat ?? `у ${subject.ru}`, negative ? 'не больно' : 'больно');
    } else {
      tj.push(...times.map((t) => t.tj), negative ? 'Дард намекунад' : 'Дард мекунад');
      ru.push(...times.map((t) => t.ru), negative ? 'не болит' : 'болит');
    }
    return finish(tj, ru, question);
  }

  // --- С глаголом: время, кто, вопрос, что, куда/где, глагол ---
  const placeTj = places.map((p) => {
    const name = p.adj ? `${ezafe(p.word)} ${p.adj.tj}` : p.word;
    return `${verb.motion ? 'ба' : 'дар'} ${name}`;
  });
  const placeRu = places.map((p) => {
    const where = verb.motion ? p.noun.place.to : p.noun.place.loc;
    return p.adj ? `${where} (${ruAdj(p.adj.adj, p.noun, false)})` : where;
  });
  // Кому помогают: «ба ман» / «мне»
  if (verb.dative) {
    for (const o of objects) {
      if (!o.ruDat) continue;
      o.tj = `ба ${o.base}`;
      o.ru = o.ruDat;
    }
  }
  // Футбол играют: «футбол бозӣ мекунам» / «играю в футбол»
  const objRu = objects.map((o) => (o.noun?.game && verb.prefix === 'бозӣ' ? `в ${o.ru}` : o.ru));

  tj.push(...times.map((t) => t.tj));
  if (subject) tj.push(subject.tj);
  if (question) tj.push(question.tj);
  tj.push(...objects.map((o) => o.tj), ...placeTj, tjVerb(verb, person, past, negative));

  if (question) ru.push(question.ru);
  ru.push(...times.map((t) => t.ru));
  if (subject) ru.push(subject.ru);
  ru.push(ruVerb(verb, person, past, negative), ...objRu, ...placeRu);
  return finish(tj, ru, question);
}

function finish(tj, ru, question) {
  const mark = question ? '?' : '.';
  const join = (parts) => cap(parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim());
  return { tj: `${join(tj)}${mark}`, ru: `${join(ru)}${mark}` };
}

/**
 * Полное предложение из распознанных жестов.
 * @param {string[]} words слова-жесты по порядку (таджикские подписи)
 * @returns {{tj: string, ru: string}}
 */
export function completeSentence(words) {
  const list = words.filter((w) => w && w.trim());
  if (!list.length) return { tj: '', ru: '' };
  const parts = clauses(list).map(clause);
  return { tj: parts.map((p) => p.tj).join(' '), ru: parts.map((p) => p.ru).join(' ') };
}
