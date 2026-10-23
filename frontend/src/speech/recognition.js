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
 * @param {(text: string, final: boolean) => void} opts.onText
 * @param {(i18nKey: string, code: string) => void} [opts.onError]
 * @param {() => void} [opts.onEnd]
 * @returns {{stop: () => void} | null} null — браузер не умеет распознавать речь
 */
export function listen({ lang, onText, onError, onEnd }) {
  if (!Recognition) return null;
  const rec = new Recognition();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (event) => {
    const text = Array.from(event.results)
      .map((r) => r[0].transcript)
      .join(' ');
    onText(text, event.results[event.results.length - 1].isFinal);
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
