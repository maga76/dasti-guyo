// Что за устройство: телефон / слабый компьютер — тогда распознавание работает в щадящем режиме,
// чтобы руки не «лагали». Работает и на странице, и в фоновых потоках (там тоже есть navigator).

const nav = typeof navigator !== 'undefined' ? navigator : {};

/** Телефон или планшет (по описанию браузера: в фоновом потоке нет matchMedia). */
export const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? '');

/** Слабое устройство: телефон или мало ядер процессора. */
export const lowPower = isMobile || (nav.hardwareConcurrency ?? 8) <= 4;
