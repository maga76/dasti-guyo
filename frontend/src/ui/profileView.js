// Экран «Профил»: регистрация и вход, а после входа — личный кабинет:
//   - «Ҳиссаи ман дар ИИ»: сколько жестов человек записал для обучения нашей нейросети,
//     сколько одобрено, сколько уже вошло в опубликованную модель;
//   - «Дониши ман»: какие жесты он уже знает (по тренажёру «Машқ»), история игр;
//   - баллы и уровень, таблица лучших.

import { getLang, onLangChange, t } from '../i18n/i18n.js';
import { ApiError, api, getUser, login, logout, onAuthChange, register } from '../api/api.js';
import { syncSamples } from '../api/sync.js';
import { flushPractice } from '../api/practiceSync.js';
import { db } from '../dataset/db.js';
import { loadBaseDataset } from '../dataset/baseDataset.js';
import { labelName } from './trainView.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = (iso) => new Date(iso).toLocaleDateString(getLang() === 'ru' ? 'ru-RU' : 'tg-TJ', { day: 'numeric', month: 'short' });

// Как в app/services/profile.py: жест «знает», если доля правильных ≥ 60% хотя бы по 2 попыткам
const KNOWN_MASTERY = 0.6;
const KNOWN_MIN_ATTEMPTS = 2;

export class ProfileView {
  constructor() {
    this.root = $('profileRoot');
    this.mode = 'register'; // register | login — форма для гостя
    this.message = null;
    this.active = false;
    this.data = null;

    this.root.addEventListener('submit', (e) => this.onSubmit(e));
    this.root.addEventListener('click', (e) => this.onClick(e));
    onLangChange(() => {
      this.renderNavLabel();
      this.paint();
    });
    onAuthChange(() => {
      this.data = null;
      this.renderNavLabel();
      if (this.active) this.load();
    });
    window.addEventListener('online', () => flushPractice());
    flushPractice();
    this.renderNavLabel();
  }

  setActive(active) {
    this.active = active;
    if (active) this.load();
  }

  /** Кнопка профиля в шапке: гость — «Ворид шудан», вошедший — первая буква и имя. */
  renderNavLabel() {
    const name = $('userChipName');
    const avatar = $('userChipAvatar');
    const user = getUser();
    $('userChip').classList.toggle('is-in', Boolean(user));
    // На телефоне имя скрыто — подпись нужна для экранного диктора
    $('userChip').setAttribute('aria-label', user ? user.username : t('pf.signIn'));
    if (user) {
      name.textContent = user.username;
      name.removeAttribute('data-i18n'); // смена языка не должна заменять имя
      avatar.textContent = user.username.slice(0, 1).toUpperCase();
    } else {
      name.dataset.i18n = 'pf.signIn';
      name.textContent = t('pf.signIn');
      avatar.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>';
    }
  }

  async load() {
    if (!getUser()) {
      this.paint();
      return;
    }
    this.loading = true;
    this.paint();
    try {
      await Promise.all([flushPractice(), syncSamples()]);
      const [profile, board, base, local] = await Promise.all([
        api('/me/profile'),
        api('/leaderboard').catch(() => null),
        loadBaseDataset(),
        db.getAllSamples(),
      ]);
      this.data = { profile, board, vocabulary: base?.vocabulary ?? [], unsynced: local.filter((s) => !s.synced).length };
      this.error = null;
    } catch (err) {
      this.error = err instanceof ApiError ? err.message : String(err);
    }
    this.loading = false;
    this.paint();
  }

  // ---------- События ----------

  async onSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const username = form.username.value.trim();
    const password = form.password.value;
    // Проверки до сервера — с понятным текстом, а не общим «неверные данные»
    if (this.mode === 'register') {
      if (!/^[\w.-]{3,50}$/u.test(username)) return this.fail(t('pf.badName'));
      if (password.length < 8) return this.fail(t('pf.shortPassword'));
      if (password !== form.password2.value) return this.fail(t('pf.passwordMismatch'));
    }
    form.querySelector('button[type=submit]').disabled = true;
    try {
      if (this.mode === 'register') await register(username, password);
      else await login(username, password);
      this.message = null;
    } catch (err) {
      this.fail(err instanceof ApiError ? err.message : String(err));
    }
  }

  fail(text) {
    this.message = text;
    this.paint();
    return null;
  }

  async onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'mode') {
      this.mode = btn.dataset.mode;
      this.message = null;
      this.paint();
    } else if (act === 'logout') {
      logout();
    } else if (act === 'sync') {
      btn.disabled = true;
      await syncSamples();
      this.load();
    }
  }

  // ---------- Отрисовка ----------

  paint() {
    if (!this.active) return;
    const user = getUser();
    if (!user) this.root.innerHTML = this.authHtml();
    else if (this.loading && !this.data) this.root.innerHTML = `<p class="pf-loading">${esc(t('pf.loading'))}</p>`;
    else if (this.error && !this.data) this.root.innerHTML = `<p class="note is-error">${esc(this.error)}</p>`;
    else this.root.innerHTML = this.dashboardHtml();
  }

  authHtml() {
    const reg = this.mode === 'register';
    const benefit = (icon, key) =>
      `<li><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${esc(t(key))}</span></li>`;
    return `
      <div class="pf-auth">
        <section class="pf-auth-intro">
          <h1>${esc(t('pf.joinTitle'))}</h1>
          <p>${esc(t('pf.joinText'))}</p>
          <ul class="pf-benefits">
            ${benefit('<circle cx="5" cy="7" r="2"/><circle cx="5" cy="17" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 7.5l3 3.5M7 16.5l3-3.5M14 12h3"/>', 'pf.benefit1')}
            ${benefit('<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>', 'pf.benefit2')}
            ${benefit('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4z"/>', 'pf.benefit3')}
          </ul>
        </section>
        <form class="pf-auth-form" novalidate>
          <div class="pf-switch" role="tablist">
            <button type="button" role="tab" data-act="mode" data-mode="register" aria-selected="${reg}">${esc(t('pf.register'))}</button>
            <button type="button" role="tab" data-act="mode" data-mode="login" aria-selected="${!reg}">${esc(t('pf.login'))}</button>
          </div>
          <label class="field">${esc(t('ad.username'))}
            <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="50" required />
            ${reg ? `<small class="muted">${esc(t('pf.nameHint'))}</small>` : ''}
          </label>
          <label class="field">${esc(t('ad.password'))}
            <input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" maxlength="72" required />
          </label>
          ${reg ? `<label class="field">${esc(t('pf.password2'))}<input name="password2" type="password" autocomplete="new-password" maxlength="72" required /></label>` : ''}
          ${this.message ? `<p class="note is-error" role="alert">${esc(this.message)}</p>` : ''}
          <button type="submit" class="btn btn-primary btn-lg">${esc(t(reg ? 'pf.registerBtn' : 'pf.loginBtn'))}</button>
          <p class="muted pf-privacy">${esc(t('pf.privacy'))}</p>
        </form>
      </div>`;
  }

  dashboardHtml() {
    const { profile: p, board, vocabulary, unsynced } = this.data;
    const user = getUser();
    const c = p.contribution;
    const k = p.knowledge;
    const progress = p.next_level_points ? Math.min(100, Math.round((p.points / p.next_level_points) * 100)) : 100;
    return `
      <header class="pf-hero">
        <span class="pf-avatar" aria-hidden="true">${esc(user.username.slice(0, 1).toUpperCase())}</span>
        <div class="pf-hero-main">
          <h1>${esc(user.username)}</h1>
          <p class="pf-level"><b>${esc(t(`pf.level.${p.level}`))}</b> · ${esc(t('pf.points', { n: p.points }))}</p>
          <div class="pf-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div>
          <p class="muted pf-next">${esc(p.next_level_points ? t('pf.toNext', { n: p.next_level_points - p.points }) : t('pf.maxLevel'))}</p>
        </div>
        <button type="button" class="btn btn-secondary btn-small" data-act="logout">${esc(t('ad.logout'))}</button>
      </header>

      <div class="pf-grid">
        ${this.contributionHtml(c, unsynced)}
        ${this.knowledgeHtml(k, vocabulary)}
      </div>
      ${board ? this.boardHtml(board, user.username) : ''}
      <p class="muted pf-rules">${esc(t('pf.rules'))}</p>`;
  }

  contributionHtml(c, unsynced) {
    const max = Math.max(1, ...c.gestures.map((g) => g.approved + g.pending));
    const rows = c.gestures
      .map(
        (g) => `
        <li>
          <span class="pf-bar-label">${esc(getLang() === 'ru' && g.name_ru ? g.name_ru : g.name_tj)}</span>
          <span class="pf-bar" aria-hidden="true">
            <i class="is-ok" style="width:${(g.approved / max) * 100}%"></i><i class="is-wait" style="width:${(g.pending / max) * 100}%"></i>
          </span>
          <span class="pf-bar-num">${g.approved}${g.pending ? ` <small>+${g.pending}</small>` : ''}</span>
        </li>`,
      )
      .join('');
    return `
      <section class="pf-card">
        <h2>${esc(t('pf.contribTitle'))}</h2>
        <div class="pf-stats">
          <div><b>${c.total}</b><span>${esc(t('pf.recorded'))}</span></div>
          <div class="is-ok"><b>${c.approved}</b><span>${esc(t('pf.approved'))}</span></div>
          <div class="is-wait"><b>${c.pending}</b><span>${esc(t('pf.pending'))}</span></div>
        </div>
        <p class="pf-model ${c.in_model ? 'is-ok' : ''}">${esc(
          c.model_version == null
            ? t('pf.noModelYet')
            : c.in_model
              ? t('pf.inModel', { n: c.in_model, v: c.model_version })
              : t('pf.notInModelYet', { v: c.model_version }),
        )}</p>
        ${rows ? `<ul class="pf-bars">${rows}</ul>` : `<p class="muted">${esc(t('pf.noSamples'))}</p>`}
        ${unsynced ? `<p class="note">${esc(t('pf.unsynced', { n: unsynced }))}</p>` : ''}
        <div class="btn-row">
          <a class="btn btn-primary" href="#/train">${esc(t('pf.recordMore'))}</a>
          ${unsynced ? `<button type="button" class="btn btn-secondary" data-act="sync">${esc(t('sync.now'))}</button>` : ''}
        </div>
      </section>`;
  }

  knowledgeHtml(k, vocabulary) {
    const skills = new Map(k.words.map((w) => [w.label, w]));
    const total = vocabulary.length || skills.size;
    const known = k.known_words;
    const percent = total ? Math.round((known / total) * 100) : 0;
    const accuracy = k.rounds ? Math.round((k.correct / k.rounds) * 100) : 0;
    // Все жесты словаря: выученные, начатые, ещё не пробованные
    const labels = vocabulary.length ? vocabulary.map((v) => v.label) : [...skills.keys()];
    const chips = labels
      .map((label) => {
        const s = skills.get(label);
        const cls = !s ? 'is-new' : s.mastery >= KNOWN_MASTERY && s.attempts >= KNOWN_MIN_ATTEMPTS ? 'is-known' : s.mastery > 0 ? 'is-learning' : 'is-hard';
        const title = s ? t('pf.wordTitle', { correct: s.correct, attempts: s.attempts }) : t('pf.wordNew');
        return `<li class="${cls}" title="${esc(title)}">${esc(labelName(label))}</li>`;
      })
      .join('');
    // История игр: доля правильных ответов
    const bars = k.history
      .map((g) => {
        const h = g.total ? Math.max(4, Math.round((g.correct / g.total) * 100)) : 4;
        return `<span style="height:${h}%" title="${esc(`${date(g.created_at)}: ${g.correct}/${g.total} · ${g.score}`)}"></span>`;
      })
      .join('');
    return `
      <section class="pf-card">
        <h2>${esc(t('pf.knowTitle'))}</h2>
        <div class="pf-know">
          <div class="pf-ring" style="--p:${percent}" role="img" aria-label="${esc(t('pf.knownOf', { n: known, total }))}">
            <b>${percent}%</b>
          </div>
          <div>
            <p class="pf-know-main">${esc(t('pf.knownOf', { n: known, total }))}</p>
            <p class="muted">${esc(t('pf.games', { games: k.games, best: k.best_score, accuracy }))}</p>
          </div>
        </div>
        ${bars ? `<div class="pf-history" aria-label="${esc(t('pf.history'))}">${bars}</div><p class="muted pf-history-label">${esc(t('pf.history'))}</p>` : ''}
        <ul class="pf-words">${chips}</ul>
        <p class="pf-legend muted">
          <span class="is-known">${esc(t('pf.legendKnown'))}</span>
          <span class="is-learning">${esc(t('pf.legendLearning'))}</span>
          <span class="is-hard">${esc(t('pf.legendHard'))}</span>
          <span class="is-new">${esc(t('pf.legendNew'))}</span>
        </p>
        <div class="btn-row"><a class="btn btn-primary" href="#/practice">${esc(t('pf.practice'))}</a></div>
      </section>`;
  }

  boardHtml(board, me) {
    const list = (rows, unit) =>
      rows.length
        ? `<ol>${rows
            .map((r) => `<li class="${r.username === me ? 'is-me' : ''}"><span>${esc(r.username)}</span><b>${esc(t(unit, { n: r.value }))}</b></li>`)
            .join('')}</ol>`
        : `<p class="muted">${esc(t('pf.boardEmpty'))}</p>`;
    return `
      <section class="pf-card pf-board">
        <h2>${esc(t('pf.boardTitle'))}</h2>
        <div class="pf-board-cols">
          <div><h3>${esc(t('pf.boardHelpers'))}</h3>${list(board.contributors, 'pf.unitSamples')}</div>
          <div><h3>${esc(t('pf.boardPlayers'))}</h3>${list(board.players, 'pf.unitPoints')}</div>
        </div>
      </section>`;
  }
}
