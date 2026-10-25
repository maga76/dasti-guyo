// Экран «Талаффуз»: тренажёр произношения таджикских слов с голосовым помощником.
//
// Помощник говорит слово нейросетевым таджикским голосом, человек повторяет в микрофон,
// сайт сравнивает услышанное с правильным словом (speech/pronunciation.js). Если не получилось —
// подсвечивает буквы и слоги с ошибкой, даёт подсказку по особой букве (ҳ қ ғ ҷ ӯ ӣ),
// повторяет слово медленно, а после второй ошибки — по слогам.
// Прогресс по словам хранится в браузере; если человек вошёл, каждая попытка уходит в профиль.
// Слова и подсказки — public/data/speech-words.json; голос — public/audio/madina (или audio/tts).
//
// Режим разговора («Сӯҳбат»): одно нажатие — и помощник сам ведёт занятие, пока не нажмут «Бас»:
// говорит слово → слушает → хвалит или подсказывает (вслух) → после 3 неудач или успеха — следующее слово.

import { getLang, onLangChange, t } from '../i18n/i18n.js';
import { Recognition, listen } from '../speech/recognition.js';
import { VOICES, currentDuration, getVoice, setVoice, speakAndWait, stop as stopVoice } from '../speech/speech.js';
import { bestMatch, specialMistakes, wrongSyllables } from '../speech/pronunciation.js';
import { getUser } from '../api/api.js';
import { flushSpeech, saveSpeech } from '../api/speechSync.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const PROGRESS_KEY = 'dasti-guyo:speechProgress';
const LEVEL_KEY = 'dasti-guyo:speechLevel';
const MASTERED_OK = 2; // как на сервере: 2 удачные попытки и последняя удачная
const MAX_CHAT = 8;
const SLOW = 0.7;
const DIALOG_TRIES = 3; // в разговоре: столько попыток на слово, потом — следующее
const DIALOG_SILENCE = 2; // столько раз подряд ничего не услышал — разговор на паузе
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const key = (word) => word.trim().toLowerCase();

function load(storageKey, fallback) {
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function save(storageKey, value) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    /* прогресс просто не запомнится */
  }
}

export class SpeechView {
  constructor() {
    this.root = $('speechRoot');
    this.data = null;
    this.level = load(LEVEL_KEY, 'easy');
    this.index = 0;
    this.progress = load(PROGRESS_KEY, {});
    this.chat = [];
    this.result = null; // {score, wrong:Set, heard, ok}
    this.fails = 0;
    this.session = null;
    this.busy = false;
    this.activeSyllable = -1;
    this.active = false;

    this.root.addEventListener('click', (e) => this.onClick(e));
    onLangChange(() => this.paint());
    window.addEventListener('online', () => flushSpeech());
    flushSpeech();
  }

  async setActive(active) {
    this.active = active;
    if (!active) {
      this.dialog = false;
      this.session?.stop();
      stopVoice();
      return;
    }
    if (!this.data) {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}data/speech-words.json`);
        this.data = await res.json();
      } catch {
        this.root.innerHTML = `<p class="note is-error">${esc(t('sp.loadError'))}</p>`;
        return;
      }
      if (!this.data.levels.some((l) => l.id === this.level)) this.level = this.data.levels[0].id;
      this.index = this.firstUnmastered();
      this.say('ai', t(Recognition ? 'sp.hello' : 'sp.noMic'));
    }
    this.paint();
  }

  // ---------- Данные ----------

  get words() {
    return this.data.words.filter((w) => w.level === this.level);
  }

  get word() {
    return this.words[this.index];
  }

  stats(word) {
    return this.progress[key(word.text)] ?? { attempts: 0, correct: 0, best: 0, last: 0, lastOk: false };
  }

  mastered(word) {
    const s = this.stats(word);
    return s.correct >= MASTERED_OK && s.lastOk;
  }

  firstUnmastered() {
    const i = this.words.findIndex((w) => !this.mastered(w));
    return i < 0 ? 0 : i;
  }

  record(word, score, ok) {
    const s = { ...this.stats(word) };
    s.attempts += 1;
    s.correct += ok ? 1 : 0;
    s.best = Math.max(s.best, score);
    s.last = score;
    s.lastOk = ok;
    this.progress[key(word.text)] = s;
    save(PROGRESS_KEY, this.progress);
  }

  // ---------- Помощник ----------

  /** Сообщение в чате помощника. who: 'ai' | 'me'. */
  say(who, text, extra = {}) {
    this.chat.push({ who, text, ...extra });
    if (this.chat.length > MAX_CHAT) this.chat.shift();
  }

  feedback(name) {
    return this.data.feedback?.[name];
  }

  async onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'level') return this.setLevel(btn.dataset.level);
    if (act === 'goto') return this.goTo(Number(btn.dataset.index));
    if (act === 'next') return this.goTo((this.index + 1) % this.words.length);
    if (act === 'prev') return this.goTo((this.index - 1 + this.words.length) % this.words.length);
    if (act === 'listen') return this.play(1);
    if (act === 'slow') return this.play(SLOW, true);
    if (act === 'mic') return this.session ? this.session.stop() : this.listenWord();
    if (act === 'dialog') return this.dialog ? this.stopDialog() : this.startDialog();
    if (act === 'voice') {
      setVoice(btn.dataset.voice);
      this.paint();
      return this.play(1);
    }
  }

  // ---------- Режим разговора ----------

  async startDialog() {
    if (!Recognition) {
      this.say('ai', t('sp.noMic'));
      this.paint();
      return;
    }
    this.dialog = true;
    this.say('ai', t('sp.dialogStart'));
    this.paint();
    await speakAndWait(this.feedback('start'));
    let silence = 0;
    let tries = 0;
    let word = null;
    while (this.dialog && this.active) {
      if (this.word !== word) {
        word = this.word;
        tries = 0;
        this.resetWord();
      }
      await this.play(1);
      if (!this.dialog) break;
      const { variants, error } = await this.hear();
      if (!this.dialog) break;
      if (error) {
        // Нет сети, нет доступа к микрофону — продолжать бессмысленно
        this.say('ai', t(error));
        this.stopDialog();
        break;
      }
      if (!variants.some((v) => v.trim())) {
        silence++;
        this.say('ai', t('sp.nothing'));
        this.paint();
        await speakAndWait(this.feedback('nothing'));
        if (silence >= DIALOG_SILENCE) {
          this.say('ai', t('sp.dialogPaused'));
          this.stopDialog();
        }
        continue;
      }
      silence = 0;
      tries++;
      const ok = await this.check(word, variants, { dialog: true });
      if (!this.dialog) break;
      if (ok || tries >= DIALOG_TRIES) {
        if (!ok) {
          this.say('ai', t('sp.moveOn'));
          this.paint();
          await speakAndWait(this.feedback('moveOn'));
        }
        if (!this.nextWord()) {
          this.say('ai', t('sp.levelDone'), { kind: 'ok' });
          this.paint();
          await speakAndWait(this.feedback('done'));
          this.stopDialog();
        }
        await pause(300);
      }
    }
  }

  stopDialog() {
    if (!this.dialog) return;
    this.dialog = false;
    this.session?.stop();
    this.say('ai', t('sp.dialogStop'));
    this.paint();
  }

  /** Перейти к следующему неосвоенному слову уровня. false — все освоены. */
  nextWord() {
    const next = this.words.findIndex((w, i) => i > this.index && !this.mastered(w));
    const any = this.words.findIndex((w) => !this.mastered(w));
    const target = next >= 0 ? next : any;
    if (target < 0) return false;
    this.index = target === this.index && this.words.length > 1 ? (this.index + 1) % this.words.length : target;
    this.resetWord();
    this.paint();
    return true;
  }

  /** Послушать человека один раз: {variants: string[], error: i18n-ключ|null}. */
  hear() {
    return new Promise((resolve) => {
      let variants = [];
      let error = null;
      stopVoice();
      this.session = listen({
        lang: 'ru-RU',
        alternatives: 5,
        onText: (text, final, alts) => {
          variants = [text, ...alts];
          if (final) this.session?.stop();
        },
        onError: (errorKey, code) => {
          if (code !== 'no-speech' && code !== 'aborted') error = errorKey;
        },
        onEnd: () => {
          this.session = null;
          this.paint();
          resolve({ variants, error });
        },
      });
      if (!this.session) resolve({ variants: [], error: 'sp.noMic' });
      this.paint();
    });
  }

  setLevel(level) {
    this.level = level;
    save(LEVEL_KEY, level);
    this.index = this.firstUnmastered();
    this.resetWord();
    this.paint();
  }

  goTo(index) {
    this.session?.stop();
    stopVoice();
    this.index = index;
    this.resetWord();
    this.paint();
  }

  resetWord() {
    this.result = null;
    this.fails = 0;
    this.activeSyllable = -1;
  }

  /** Произнести слово; slow — медленно, подсвечивая слоги по очереди. */
  async play(rate, bySyllables = false) {
    if (this.busy) return;
    this.busy = true;
    this.paint();
    const word = this.word;
    const playing = speakAndWait(word.text, { rate });
    if (bySyllables && word.syllables.length > 1) this.highlightSyllables(word);
    await playing;
    this.activeSyllable = -1;
    this.busy = false;
    this.paint();
  }

  /** Подсветка слогов в такт медленному произношению (длительность — от записи голоса). */
  async highlightSyllables(word) {
    await new Promise((r) => setTimeout(r, 60));
    const total = (currentDuration() ?? word.syllables.length * 0.45) * 1000;
    const letters = word.syllables.map((s) => s.length);
    const sum = letters.reduce((a, b) => a + b, 0);
    for (let i = 0; i < word.syllables.length && this.busy; i++) {
      this.activeSyllable = i;
      this.paint();
      await new Promise((r) => setTimeout(r, (total * letters[i]) / sum));
    }
  }

  listenWord() {
    if (!Recognition) {
      this.say('ai', t('sp.noMic'));
      this.paint();
      return;
    }
    stopVoice();
    const word = this.word;
    let heard = [];
    let failed = false; // уже сказали причину (нет сети, нет доступа к микрофону) — «не услышал» не добавляем
    this.result = null;
    this.session = listen({
      // Таджикский распознаватель в браузерах почти не встречается — слушаем русским (см. pronunciation.js)
      lang: 'ru-RU',
      alternatives: 5,
      onText: (text, final, alts) => {
        heard = [text, ...alts];
        if (final) this.session?.stop();
      },
      onError: (errorKey, code) => {
        if (code !== 'no-speech' && code !== 'aborted') {
          failed = true;
          this.say('ai', t(errorKey));
        }
      },
      onEnd: () => {
        this.session = null;
        if (word === this.word && !failed && !this.dialog) this.check(word, heard);
        else this.paint();
      },
    });
    this.paint();
  }

  /**
   * Оценить попытку, сказать результат и помочь при ошибке.
   * @param {{dialog?: boolean}} [opts] dialog — режим разговора: следующее слово выбирает он сам
   * @returns {Promise<boolean>} получилось ли
   */
  async check(word, heard, { dialog = false } = {}) {
    if (!heard.some((h) => h.trim())) {
      this.say('ai', t('sp.nothing'));
      this.paint();
      return false;
    }
    const pass = this.data.pass ?? 0.75;
    const r = bestMatch(word.text, heard);
    const ok = r.score >= pass;
    const percent = Math.round(r.score * 100);
    const wasMastered = this.mastered(word);
    this.result = { ...r, ok };
    this.record(word, r.score, ok);
    saveSpeech({ word: word.text, score: r.score, heard: r.heard.slice(0, 200) || null });
    this.say('me', r.heard || heard[0]);

    if (ok) {
      this.fails = 0;
      this.say('ai', t(percent >= 90 ? 'sp.great' : 'sp.good', { score: percent }), { kind: 'ok' });
      if (!wasMastered && this.mastered(word)) this.say('ai', t('sp.mastered', { word: word.text }), { kind: 'ok' });
      this.paint();
      await speakAndWait(this.feedback(percent >= 90 ? 'great' : 'good'));
      // Дальше — следующее неосвоенное слово уровня (в разговоре это решает сам разговор)
      if (!dialog && word === this.word) {
        await pause(700);
        if (word === this.word && !this.nextWord()) {
          this.say('ai', t('sp.levelDone'), { kind: 'ok' });
          this.paint();
          await speakAndWait(this.feedback('done'));
        }
      }
      return true;
    }

    // Не получилось: что именно, подсказки (в разговоре — вслух), и слово ещё раз — медленно,
    // после второй ошибки — по слогам
    this.fails += 1;
    this.say('ai', t('sp.again', { score: percent }), { kind: 'bad' });
    const tips = specialMistakes(word.text, r.wrong)
      .map((letter) => this.data.tips?.[letter])
      .filter(Boolean);
    for (const tip of tips) this.say('ai', tip[getLang() === 'ru' ? 'ru' : 'tg'], { kind: 'tip' });
    const bySyllables = this.fails >= 2 && word.syllables.length > 1;
    if (bySyllables) this.say('ai', t('sp.bySyllables', { syllables: word.syllables.join(' — ') }), { kind: 'tip' });
    this.paint();
    await speakAndWait(this.feedback('again'));
    if (dialog) for (const tip of tips) if (this.dialog) await speakAndWait(tip.tg);
    if (dialog && bySyllables && this.dialog) await speakAndWait(this.feedback('syllables'));
    if (word === this.word && (!dialog || this.dialog)) await this.play(SLOW, bySyllables);
    return false;
  }

  // ---------- Отрисовка ----------

  paint() {
    if (!this.active || !this.data) return;
    const lang = getLang() === 'ru' ? 'ru' : 'tg';
    const word = this.word;
    const words = this.words;
    const r = this.result;
    const listening = Boolean(this.session);

    const letters = [...word.text]
      .map((ch, i) => `<span class="${r ? (r.wrong.has(i) ? 'is-bad' : /\p{L}/u.test(ch) ? 'is-ok' : '') : ''}">${esc(ch)}</span>`)
      .join('');
    const badSyl = r ? wrongSyllables(word.text, word.syllables, r.wrong) : [];
    const syllables = word.syllables
      .map((s, i) => `<span class="sp-syl${badSyl[i] ? ' is-bad' : ''}${i === this.activeSyllable ? ' is-active' : ''}">${esc(s)}</span>`)
      .join('');
    const percent = r ? Math.round(r.score * 100) : null;

    this.root.innerHTML = `
      <header class="sp-head">
        <div>
          <h1>${esc(t('sp.title'))}</h1>
          <p class="muted">${esc(t('sp.intro'))}</p>
        </div>
        <div class="sp-voice" role="group" aria-label="${esc(t('sp.voice'))}">
          <span class="muted">${esc(t('sp.voice'))}:</span>
          ${VOICES.map(
            (v) => `<button type="button" data-act="voice" data-voice="${v}" aria-pressed="${getVoice() === v}" ${this.dialog || this.busy ? 'disabled' : ''}>${esc(t(`sp.voice.${v}`))}</button>`,
          ).join('')}
        </div>
        <nav class="sp-levels" aria-label="${esc(t('sp.levels'))}">
          ${this.data.levels
            .map((l) => {
              const list = this.data.words.filter((w) => w.level === l.id);
              const done = list.filter((w) => this.mastered(w)).length;
              return `<button type="button" data-act="level" data-level="${l.id}" aria-pressed="${l.id === this.level}">
                <span>${esc(l[lang])}</span><small>${done}/${list.length}</small></button>`;
            })
            .join('')}
        </nav>
      </header>

      <div class="sp-main">
        <section class="sp-card" aria-live="polite">
          <div class="sp-top">
            <span class="muted">${esc(t('sp.wordOf', { n: this.index + 1, total: words.length }))}</span>
            <div class="sp-dots" aria-hidden="true">${words
              .map((w, i) => `<i class="${this.mastered(w) ? 'is-ok' : this.stats(w).attempts ? 'is-tried' : ''}${i === this.index ? ' is-current' : ''}"></i>`)
              .join('')}</div>
          </div>
          <p class="sp-word" lang="tg">${letters}</p>
          <p class="sp-ru">${esc(word.ru)}</p>
          <div class="sp-syllables" lang="tg">${syllables}</div>

          <button type="button" class="btn btn-lg sp-dialog${this.dialog ? ' is-on' : ''}" data-act="dialog">
            <svg viewBox="0 0 24 24" aria-hidden="true">${
              this.dialog
                ? '<rect x="6" y="6" width="12" height="12" rx="2"/>'
                : '<path d="M4 5h16v10H9l-5 4V5z"/><path d="M8 9h8M8 12h5"/>'
            }</svg>
            ${esc(t(this.dialog ? 'sp.dialogStopBtn' : 'sp.dialogBtn'))}</button>
          ${this.dialog ? `<p class="sp-dialog-state" aria-live="polite">${esc(t(listening ? 'sp.listening' : 'sp.dialogSpeaking'))}</p>` : ''}

          <div class="sp-actions">
            <button type="button" class="btn btn-secondary" data-act="listen" ${this.busy || listening || this.dialog ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12"/></svg>
              ${esc(t('sp.listen'))}</button>
            <button type="button" class="btn btn-secondary" data-act="slow" ${this.busy || listening || this.dialog ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 13l3-3M12 3v2"/></svg>
              ${esc(t('sp.slow'))}</button>
            <button type="button" class="btn btn-primary sp-mic${listening ? ' is-listening' : ''}" data-act="mic" ${this.busy || this.dialog ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>
              ${esc(t(listening ? 'sp.listening' : 'sp.speak'))}</button>
          </div>

          ${
            r
              ? `<div class="sp-result ${r.ok ? 'is-ok' : 'is-bad'}">
                  <div class="sp-ring" style="--p:${percent}"><b>${percent}%</b></div>
                  <p>${esc(t(r.ok ? (percent >= 90 ? 'sp.great' : 'sp.good') : 'sp.again', { score: percent }))}</p>
                </div>`
              : ''
          }

          <div class="sp-nav">
            <button type="button" class="btn btn-secondary btn-small" data-act="prev">← ${esc(t('sp.prev'))}</button>
            <button type="button" class="btn btn-secondary btn-small" data-act="next">${esc(t('sp.next'))} →</button>
          </div>
        </section>

        <section class="sp-chat" aria-label="${esc(t('sp.assistant'))}">
          <h2><span class="sp-bot" aria-hidden="true">
            <svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 7V4M9 13h.01M15 13h.01"/></svg></span>
            ${esc(t('sp.assistant'))}</h2>
          <ol class="sp-messages">
            ${this.chat.map((m) => `<li class="sp-msg is-${m.who}${m.kind ? ` is-${m.kind}` : ''}">${esc(m.text)}</li>`).join('')}
          </ol>
        </section>
      </div>

      ${this.tableHtml(lang)}
      <p class="hint">${esc(t('sp.hint'))}</p>`;
  }

  tableHtml(lang) {
    const all = this.data.words;
    const total = all.reduce(
      (acc, w) => {
        const s = this.stats(w);
        acc.attempts += s.attempts;
        acc.correct += s.correct;
        acc.mastered += this.mastered(w) ? 1 : 0;
        return acc;
      },
      { attempts: 0, correct: 0, mastered: 0 },
    );
    const accuracy = total.attempts ? Math.round((total.correct / total.attempts) * 100) : 0;
    const rows = this.words
      .map((w, i) => {
        const s = this.stats(w);
        const status = this.mastered(w) ? 'mastered' : s.attempts ? 'learning' : 'new';
        return `<tr class="${i === this.index ? 'is-current' : ''}">
          <td><button type="button" class="sp-link" data-act="goto" data-index="${i}" lang="tg">${esc(w.text)}</button><small>${esc(w.ru)}</small></td>
          <td>${s.attempts}</td>
          <td><span class="sp-bar"><i style="width:${Math.round(s.best * 100)}%"></i></span>${s.attempts ? `${Math.round(s.best * 100)}%` : '—'}</td>
          <td><span class="sp-status is-${status}">${esc(t(`sp.status.${status}`))}</span></td>
        </tr>`;
      })
      .join('');
    return `
      <section class="sp-progress">
        <h2>${esc(t('sp.progressTitle'))}</h2>
        <div class="pf-stats">
          <div class="is-ok"><b>${total.mastered}</b><span>${esc(t('sp.statMastered', { total: all.length }))}</span></div>
          <div><b>${accuracy}%</b><span>${esc(t('sp.statAccuracy'))}</span></div>
          <div><b>${total.attempts}</b><span>${esc(t('sp.statAttempts'))}</span></div>
        </div>
        ${getUser() ? '' : `<p class="note">${esc(t('sp.loginToSave'))} <a href="#/profile">${esc(t('pf.signIn'))}</a></p>`}
        <div class="sp-table-wrap">
          <table class="sp-table">
            <thead><tr><th>${esc(t('sp.colWord'))}</th><th>${esc(t('sp.colTries'))}</th><th>${esc(t('sp.colBest'))}</th><th>${esc(t('sp.colStatus'))}</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
  }
}
