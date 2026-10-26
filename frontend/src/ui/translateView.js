// Экран «Тарҷума»: жест → слово → предложение → голос.
//
// Защита от мусора:
//   - слово засчитывается, только если модель уверена (порог настраивается, по умолчанию 80%)
//     и два из трёх последних ответов совпадают (жест держится ~0.5 с);
//   - то же слово второй раз подряд добавится, только если между ними руки опускали;
//   - между словами — пауза не меньше 0.8 с.
// Слова складываются в предложение по правилам из словаря (public/data/phrases.json + сервер).

import { onLangChange, t } from '../i18n/i18n.js';
import { NONE_LABEL } from '../dataset/dataset.js';
import { loadBaseDataset } from '../dataset/baseDataset.js';
import { buildSentence, loadDictionary } from '../dataset/dictionary.js';
import { labelName } from './trainView.js';
import { SignDemo } from './signDemo.js';
import { showBigText } from './bigText.js';
import { preloadSpeech, speak, speakSentence } from '../speech/speech.js';

const $ = (id) => document.getElementById(id);

const AUTO_SPEAK_KEY = 'dasti-guyo:autoSpeak';
// v2: у модели с классом «не наш жест» лучший порог — 0.6 (см. backend/tools/build_slovo_base.py,
// ACCEPT); новый ключ, чтобы прежний сохранённый 0.8 не мешал
const THRESHOLD_KEY = 'dasti-guyo:threshold-v2';
export const DEFAULT_THRESHOLD = '0.6';
// Слово засчитывается, только если модель уверенно назвала его в 3 из 4 последних ответов
// (~0.6 с): случайный ошибочный ответ в одном окне не превращается в слово
export const HISTORY = 4;
export const MIN_AGREE = 3;
const MIN_GAP_MS = 800;

function readSetting(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* настройка просто не запомнится */
  }
}

export class TranslateView {
  /**
   * @param {object} deps
   * @param {import('../model/classifier.js').GestureClassifier} deps.classifier
   * @param {import('../recognizer/recognizer.js').LiveRecognizer} deps.recognizer
   * @param {() => boolean} deps.isCameraOn
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.active = true;
    this.history = [];
    this.vocabulary = new Map(); // label → {ru, note} из базового набора
    this.demo = new SignDemo($('demoCanvas'));
    this.demoLabel = null;

    // Предложение
    this.words = [];
    this.rules = [];
    this.lastAdded = null;
    this.lastAddedAt = 0;
    this.idleSinceAdded = true;
    this.currentWord = null;

    this.threshold = Number(readSetting(THRESHOLD_KEY, DEFAULT_THRESHOLD));
    preloadSpeech();
    this.bindEvents();
    onLangChange(() => this.update());

    loadBaseDataset().then((base) => {
      for (const v of base?.vocabulary ?? []) this.vocabulary.set(v.label, v);
      this.update();
    });
    loadDictionary().then(({ phrases, quickPhrases }) => {
      this.rules = phrases;
      this.renderQuick(quickPhrases);
      this.renderSentence();
    });
  }

  bindEvents() {
    this.recognizer.onPrediction((p) => this.onPrediction(p));

    $('vocabGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-label]');
      if (btn) this.showDemo(btn.dataset.label);
    });
    $('demoNext').addEventListener('click', () => this.showDemo(this.demoLabel));
    $('demoClose').addEventListener('click', () => this.hideDemo());
    $('demoSpeak').addEventListener('click', () => this.say(labelName(this.demoLabel), true));
    $('btnSpeak').addEventListener('click', () => this.say(this.currentWord, true));

    // Предложение
    $('btnBackspace').addEventListener('click', () => {
      this.words.pop();
      this.renderSentence();
    });
    $('btnClear').addEventListener('click', () => {
      this.words = [];
      this.lastAdded = null;
      this.renderSentence();
    });
    $('btnSpeakSentence').addEventListener('click', () => {
      const s = buildSentence(this.words, this.rules);
      if (this.words.length) speakSentence(s.tj, this.words);
    });
    $('btnShowBig').addEventListener('click', () => showBigText(buildSentence(this.words, this.rules).tj));

    // Быстрые фразы: произнести и показать крупно
    $('quickGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-text]');
      if (!btn) return;
      speak(btn.dataset.text);
      showBigText(btn.dataset.text);
    });

    // Настройки
    const auto = $('chkAutoSpeak');
    auto.checked = readSetting(AUTO_SPEAK_KEY, '1') !== '0';
    auto.addEventListener('change', () => saveSetting(AUTO_SPEAK_KEY, auto.checked ? '1' : '0'));
    const slider = $('threshold');
    slider.value = Math.round(this.threshold * 100);
    $('thresholdValue').textContent = `${slider.value}%`;
    slider.addEventListener('input', () => {
      this.threshold = Number(slider.value) / 100;
      $('thresholdValue').textContent = `${slider.value}%`;
      saveSetting(THRESHOLD_KEY, String(this.threshold));
    });
  }

  setActive(active) {
    this.active = active;
    this.history = [];
    if (active) this.update();
    else this.hideDemo();
  }

  /** Перерисовывает экран: есть ли модель, включена ли камера, список жестов. */
  update() {
    const ready = this.classifier.isReady;
    $('readout').hidden = !ready;
    $('trEmpty').hidden = ready || !this.classifier.loadAttempted;
    $('vocab').hidden = !ready;
    this.showIdle();
    this.renderSentence();

    const labels = (this.classifier.meta?.labels ?? []).filter((l) => l !== NONE_LABEL);
    $('vocabGrid').replaceChildren(
      ...labels.map((label) => {
        const info = this.vocabulary.get(label);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vocab-word';
        btn.dataset.label = label;
        btn.innerHTML = '<b></b><small></small>';
        btn.querySelector('b').textContent = labelName(label);
        btn.querySelector('small').textContent = info ? info.ru : t('tr.ownGesture');
        btn.disabled = !info; // показать можно только жесты из набора Slovo
        btn.setAttribute('aria-pressed', String(label === this.demoLabel));
        return btn;
      }),
    );
    if (this.demoLabel) this.renderDemoText();
  }

  renderQuick(items) {
    $('quickGrid').replaceChildren(
      ...items.map((q) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'quick-btn';
        btn.dataset.text = q.text_tj;
        btn.innerHTML = '<b></b><small></small>';
        btn.querySelector('b').textContent = q.text_tj;
        btn.querySelector('small').textContent = q.text_ru;
        return btn;
      }),
    );
  }

  renderSentence() {
    const text = $('sentenceText');
    const sub = $('sentenceSub');
    const empty = !this.words.length;
    text.classList.toggle('is-empty', empty);
    if (empty) {
      text.textContent = t('tr.sentenceEmpty');
      sub.textContent = '';
    } else {
      const s = buildSentence(this.words, this.rules);
      text.textContent = s.tj;
      sub.textContent = s.ru !== s.tj ? s.ru : '';
    }
    for (const id of ['btnBackspace', 'btnClear', 'btnSpeakSentence', 'btnShowBig']) $(id).disabled = empty;
  }

  /** Произнести текст; если голоса нет — коротко сказать об этом (только при нажатии кнопки). */
  async say(text, manual = false) {
    if (!text) return;
    const source = await speak(text);
    if (!source && manual) {
      const caption = $('readoutCaption');
      caption.textContent = t('speech.none');
      setTimeout(() => (caption.textContent = t('tr.sees')), 2000);
    }
  }

  showIdle() {
    this.currentWord = null;
    this.idleSinceAdded = true;
    $('btnSpeak').disabled = true;
    const word = $('readoutWord');
    word.textContent = this.isCameraOn() ? t('tr.idle') : t('tr.cameraOff');
    word.classList.add('is-idle');
    $('readoutBar').style.width = '0%';
  }

  /** Ответ распознавателя (~7 раз в секунду). */
  onPrediction({ label, confidence, hands }) {
    if (!this.active) return;
    this.history.push(hands && confidence >= this.threshold ? label : NONE_LABEL);
    if (this.history.length > HISTORY) this.history.shift();

    const counts = new Map();
    for (const l of this.history) counts.set(l, (counts.get(l) ?? 0) + 1);
    const [best, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (best === NONE_LABEL || n < MIN_AGREE) {
      this.showIdle();
      return;
    }
    const word = $('readoutWord');
    this.currentWord = labelName(best);
    word.textContent = this.currentWord;
    word.classList.remove('is-idle');
    $('btnSpeak').disabled = false;
    $('readoutBar').style.width = `${Math.round(confidence * 100)}%`;
    this.maybeAccept(best);
  }

  /** Засчитать слово: добавить в предложение и произнести. */
  maybeAccept(label) {
    const now = performance.now();
    if (now - this.lastAddedAt < MIN_GAP_MS) return;
    // То же слово ещё раз — только если между ними руки опускали
    if (label === this.lastAdded && !this.idleSinceAdded) return;
    this.lastAdded = label;
    this.lastAddedAt = now;
    this.idleSinceAdded = false;
    this.words.push(labelName(label));
    this.renderSentence();
    if ($('chkAutoSpeak').checked) this.say(labelName(label));
  }

  // ---------- Как показать жест ----------

  async showDemo(label) {
    this.demoLabel = label;
    $('demo').hidden = false;
    this.renderDemoText();
    document.querySelectorAll('.vocab-word').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.label === label)));
    await this.demo.play(label);
    $('demo').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  renderDemoText() {
    const info = this.vocabulary.get(this.demoLabel);
    $('demoWord').textContent = labelName(this.demoLabel);
    $('demoRu').textContent = info?.ru ?? '';
    $('demoNote').textContent = [t('tr.demoMirror'), info?.note === 'national' ? t('tr.demoNational') : '']
      .filter(Boolean)
      .join(' ');
  }

  hideDemo() {
    this.demo.stop();
    this.demoLabel = null;
    $('demo').hidden = true;
    document.querySelectorAll('.vocab-word').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  }
}
