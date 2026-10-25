// Распознавание речи (Web Speech API) — общий модуль для ответа слышащего и для аватара.
// В Chrome звук для распознавания обрабатывают серверы Google (так устроен браузер).
// Таджикский язык распознаётся редко — тогда ошибка 'tr.micNoLang' и предложение перейти на русский.

export const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const ERROR_KEYS = {
  'language-not-supported': 'tr.micNoLang',
  'not-allowed': 'tr.micDenied',
  'service-not-allowed': 'tr.micDenied',
  'no-speech': 'tr.micNoSpeech',
  network: 'tr.micNetwork',
};

/**
 * Слушать речь до паузы.
 * @param {object} opts
 * @param {string} opts.lang 'tg-TJ' | 'ru-RU'
 * @param {(text: string, final: boolean, alternatives: string[]) => void} opts.onText
 *   alternatives — другие варианты того, что услышано (их просят через opts.alternatives)
 * @param {(i18nKey: string, code: string) => void} [opts.onError]
 * @param {() => void} [opts.onEnd]
 * @param {number} [opts.alternatives] сколько вариантов распознавания просить (по умолчанию 1)
 * @returns {{stop: () => void} | null} null — браузер не умеет распознавать речь
 */
export function listen({ lang, onText, onError, onEnd, alternatives = 1 }) {
  if (!Recognition) return null;
  const rec = new Recognition();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = alternatives;
  rec.onresult = (event) => {
    const results = Array.from(event.results);
    const text = results.map((r) => r[0].transcript).join(' ');
    const last = results[results.length - 1];
    const alts = Array.from(last, (alt) => alt.transcript);
    onText(text, last.isFinal, alts);
  };
  rec.onerror = (event) => onError?.(ERROR_KEYS[event.error] ?? 'tr.micError', event.error);
  rec.onend = () => onEnd?.();
  try {
    rec.start();
  } catch {
    onError?.('tr.micError', 'start');
    return null;
  }
  return { stop: () => rec.stop() };
}
