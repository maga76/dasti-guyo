// Тренажёр «Машқ»: сайт показывает жест (анимация по записи Slovo), человек повторяет
// его перед камерой, модель проверяет. 10 раундов по 10 секунд, баллы и серия.

import { onLangChange, t } from '../i18n/i18n.js';
import { NONE_LABEL } from '../dataset/dataset.js';
import { loadBaseDataset } from '../dataset/baseDataset.js';
import { SignDemo } from './signDemo.js';
import { labelName } from './trainView.js';
import { speak } from '../speech/speech.js';

const $ = (id) => document.getElementById(id);

const ROUNDS = 10;
const ROUND_MS = 10_000;
const MIN_CONFIDENCE = 0.6; // в тренажёре чуть мягче, чем в переводчике
const NEED_HITS = 2; // столько ответов модели подряд должны совпасть с заданием
const BEST_KEY = 'dasti-guyo:practiceBest';

export class PracticeView {
  /**
   * @param {object} deps
   * @param {import('../model/classifier.js').GestureClassifier} deps.classifier
   * @param {import('../recognizer/recognizer.js').LiveRecognizer} deps.recognizer
   * @param {() => boolean} deps.isCameraOn
   * @param {() => Promise<void>} deps.startCamera
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.demo = new SignDemo($('pCanvas'));
    this.vocabulary = new Map();
    this.state = 'idle'; // idle | playing | done
    this.target = null;
    this.timer = 0;
    this.tick = 0;

    loadBaseDataset().then((base) => {
      for (const v of base?.vocabulary ?? []) this.vocabulary.set(v.label, v);
      this.render();
    });
    this.recognizer.onPrediction((p) => this.onPrediction(p));
    $('pStart').addEventListener('click', () => this.start());
    $('pSkip').addEventListener('click', () => this.finishRound(false, true));
    onLangChange(() => this.render());
    this.render();
  }

  setActive(active) {
    if (!active && this.state === 'playing') this.stop();
    if (active) this.render(); // модель могла загрузиться, пока экран был скрыт
  }

  /** Жесты, которые можно и показать (есть запись), и распознать (есть в модели). */
  words() {
    const known = new Set(this.classifier.meta?.labels ?? []);
    return [...this.vocabulary.keys()].filter((l) => l !== NONE_LABEL && known.has(l));
  }

  async start() {
    if (!this.words().length) return;
    if (!this.isCameraOn()) await this.startCamera();
    this.round = 0;
    this.score = 0;
    this.correct = 0;
    this.streak = 0;
    this.state = 'playing';
    this.nextRound();
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.tick);
    this.demo.stop();
    this.state = 'idle';
    this.render();
  }

  nextRound() {
    if (this.round >= ROUNDS) {
      this.finishGame();
      return;
    }
    this.round++;
    const words = this.words().filter((w) => w !== this.target);
    this.target = words[Math.floor(Math.random() * words.length)];
    this.hits = 0;
    this.listening = true;
    this.result = null;
    this.deadline = performance.now() + ROUND_MS;
    this.demo.play(this.target);
    clearTimeout(this.timer);
    clearInterval(this.tick);
    this.timer = setTimeout(() => this.finishRound(false), ROUND_MS);
    this.tick = setInterval(() => this.renderTimer(), 100);
    this.render();
  }

  onPrediction({ label, confidence, hands }) {
    if (this.state !== 'playing' || !this.listening) return;
    if (hands && label === this.target && confidence >= MIN_CONFIDENCE) {
      this.hits++;
      if (this.hits >= NEED_HITS) this.finishRound(true);
    } else {
      this.hits = 0;
    }
  }

  finishRound(success, skipped = false) {
    if (this.state !== 'playing' || !this.listening) return;
    this.listening = false;
    clearTimeout(this.timer);
    clearInterval(this.tick);
    if (success) {
      const points = 10 + Math.min(this.streak, 5) * 2; // бонус за серию
      this.score += points;
      this.correct++;
      this.streak++;
      this.result = { ok: true, points };
      speak(labelName(this.target));
    } else {
      this.streak = 0;
      this.result = { ok: false, skipped };
    }
    this.render();
    this.timer = setTimeout(() => this.nextRound(), success ? 1500 : 2200);
  }

  finishGame() {
    this.state = 'done';
    this.demo.stop();
    let best = 0;
    try {
      best = Number(localStorage.getItem(BEST_KEY) ?? 0);
      if (this.score > best) localStorage.setItem(BEST_KEY, String(this.score));
    } catch {
      /* рекорд просто не запомнится */
    }
    this.isRecord = this.score > best;
    this.render();
  }

  renderTimer() {
    const left = Math.max(0, this.deadline - performance.now());
    $('pTimerBar').style.width = `${(left / ROUND_MS) * 100}%`;
  }

  render() {
    const playing = this.state === 'playing';
    const done = this.state === 'done';
    const empty = !this.words().length;
    $('pGame').hidden = !playing;
    $('pIntro').hidden = playing;
    $('pSkip').hidden = !playing;
    $('pStart').hidden = playing;
    $('pStart').disabled = empty;
    $('pStart').textContent = t(done ? 'pr.again' : 'pr.start');

    if (playing) {
      const info = this.vocabulary.get(this.target);
      $('pRound').textContent = t('pr.round', { n: this.round, total: ROUNDS });
      $('pScore').textContent = t('pr.score', { n: this.score });
      $('pWord').textContent = labelName(this.target);
      $('pRu').textContent = info?.ru ?? '';
      const r = this.result;
      const res = $('pResult');
      res.className = `practice-result${r ? (r.ok ? ' is-ok' : ' is-bad') : ''}`;
      res.textContent = !r
        ? t('pr.go')
        : r.ok
          ? t('pr.correct', { points: r.points })
          : t(r.skipped ? 'pr.skipped' : 'pr.timeout');
      this.renderTimer();
    } else if (done) {
      $('pIntroText').textContent = t(this.isRecord ? 'pr.doneRecord' : 'pr.done', {
        score: this.score,
        correct: this.correct,
        total: ROUNDS,
      });
    } else {
      $('pIntroText').textContent = t(empty ? 'pr.noWords' : 'pr.intro');
    }
  }
}
