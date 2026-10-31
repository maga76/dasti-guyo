// Экран «Дастгирӣ» (поддержка): человек пишет, что не работает или что добавить.
// Писать можно без входа; если человек вошёл — сообщение привязано к его аккаунту.
// Администратор на этом же экране видит все сообщения и отмечает разобранные.

import { getLang, onLangChange, t } from '../i18n/i18n.js';
import { ApiError, api, getUser, isAdmin, onAuthChange } from '../api/api.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const KINDS = ['problem', 'idea', 'other'];
// Подсказки «о чём написать» — нажатие начинает сообщение
const STARTERS = ['sup.start.sign', 'sup.start.voice', 'sup.start.word', 'sup.start.slow', 'sup.start.page'];

export class SupportView {
  constructor() {
    this.root = $('supportRoot');
    this.kind = 'problem';
    this.sent = false;
    this.inbox = null;
    this.active = false;
    this.root.addEventListener('submit', (e) => this.onSubmit(e));
    this.root.addEventListener('click', (e) => this.onClick(e));
    onLangChange(() => this.paint());
    onAuthChange(() => this.active && this.load());
  }

  setActive(active) {
    this.active = active;
    if (active) this.load();
  }

  async load() {
    this.paint();
    if (!isAdmin()) return;
    try {
      this.inbox = await api('/support', { timeout: 15_000 });
    } catch (err) {
      this.inbox = { error: err instanceof ApiError ? err.message : String(err) };
    }
    this.paint();
  }

  async onSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const message = form.message.value.trim();
    if (message.length < 3) return this.fail(t('sup.tooShort'));
    form.querySelector('button[type=submit]').disabled = true;
    try {
      await api('/support', {
        method: 'POST',
        body: { kind: this.kind, message, contact: form.contact.value.trim() || null, page: this.fromPage ?? null },
        timeout: 30_000,
        retries: 1,
      });
      this.sent = true;
      this.error = null;
      this.draft = '';
      this.load();
    } catch (err) {
      this.draft = message;
      this.fail(err instanceof ApiError ? err.message : String(err));
    }
  }

  fail(text) {
    this.error = text;
    this.paint();
  }

  async onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'kind') {
      this.kind = btn.dataset.kind;
      this.keepDraft();
      this.paint();
    } else if (act === 'starter') {
      const box = this.root.querySelector('textarea');
      box.value = `${t(btn.dataset.key)} `;
      box.focus();
    } else if (act === 'again') {
      this.sent = false;
      this.paint();
    } else if (act === 'status') {
      btn.disabled = true;
      await api(`/support/${btn.dataset.id}`, { method: 'PATCH', body: { status: btn.dataset.status } }).catch(() => null);
      this.load();
    }
  }

  /** Текст не должен пропадать, если человек переключил «проблема/идея». */
  keepDraft() {
    const box = this.root.querySelector('textarea');
    if (box) this.draft = box.value;
  }

  paint() {
    if (!this.active) return;
    this.root.innerHTML = `
      <div class="sup">
        <section class="sup-intro">
          <h1>${esc(t('sup.title'))}</h1>
          <p>${esc(t('sup.intro'))}</p>
          <ul class="sup-points">
            <li>${esc(t('sup.point1'))}</li>
            <li>${esc(t('sup.point2'))}</li>
            <li>${esc(t('sup.point3'))}</li>
          </ul>
        </section>
        ${this.sent ? this.thanksHtml() : this.formHtml()}
      </div>
      ${isAdmin() ? this.inboxHtml() : ''}`;
  }

  thanksHtml() {
    return `
      <section class="sup-card sup-thanks" role="status">
        <h2>${esc(t('sup.thanksTitle'))}</h2>
        <p>${esc(t('sup.thanksText'))}</p>
        <button type="button" class="btn btn-secondary" data-act="again">${esc(t('sup.again'))}</button>
      </section>`;
  }

  formHtml() {
    const user = getUser();
    return `
      <form class="sup-card" novalidate>
        <div class="sup-kinds" role="radiogroup" aria-label="${esc(t('sup.kindLabel'))}">
          ${KINDS.map(
            (k) =>
              `<button type="button" role="radio" data-act="kind" data-kind="${k}" aria-checked="${this.kind === k}">${esc(t(`sup.kind.${k}`))}</button>`,
          ).join('')}
        </div>
        <div class="sup-starters">
          ${STARTERS.map((key) => `<button type="button" data-act="starter" data-key="${key}">${esc(t(key))}</button>`).join('')}
        </div>
        <label class="field">${esc(t(this.kind === 'idea' ? 'sup.messageIdea' : 'sup.message'))}
          <textarea name="message" rows="6" maxlength="2000" required>${esc(this.draft ?? '')}</textarea>
        </label>
        <label class="field">${esc(t('sup.contact'))}
          <input name="contact" maxlength="120" autocomplete="tel" placeholder="${esc(t('sup.contactHint'))}" />
          ${user ? `<small class="muted">${esc(t('sup.asUser', { name: user.username }))}</small>` : ''}
        </label>
        ${this.error ? `<p class="note is-error" role="alert">${esc(this.error)}</p>` : ''}
        <button type="submit" class="btn btn-primary btn-lg">${esc(t('sup.send'))}</button>
        <p class="muted sup-privacy">${esc(t('sup.privacy'))}</p>
      </form>`;
  }

  inboxHtml() {
    const box = this.inbox;
    if (!box) return `<section class="sup-inbox"><h2>${esc(t('sup.inbox'))}</h2><p class="muted">${esc(t('pf.loading'))}</p></section>`;
    if (box.error) return `<section class="sup-inbox"><h2>${esc(t('sup.inbox'))}</h2><p class="note is-error">${esc(box.error)}</p></section>`;
    const date = (iso) => new Date(iso).toLocaleString(getLang() === 'ru' ? 'ru-RU' : 'tg-TJ', { dateStyle: 'short', timeStyle: 'short' });
    const items = box.items
      .map(
        (m) => `
        <li class="sup-msg is-${m.status}">
          <div class="sup-msg-head">
            <span class="sup-tag is-${m.kind}">${esc(t(`sup.kind.${m.kind}`))}</span>
            <span class="muted">${esc(date(m.created_at))} · ${esc(m.username ?? t('sup.guest'))}${m.page ? ` · ${esc(m.page)}` : ''}</span>
            <button type="button" class="btn btn-secondary btn-small" data-act="status" data-id="${m.id}" data-status="${m.status === 'new' ? 'done' : 'new'}">
              ${esc(t(m.status === 'new' ? 'sup.markDone' : 'sup.markNew'))}</button>
          </div>
          <p>${esc(m.message)}</p>
          ${m.contact ? `<p class="sup-contact">${esc(t('sup.contactShort'))}: <b>${esc(m.contact)}</b></p>` : ''}
          ${m.user_agent ? `<p class="muted sup-ua">${esc(m.user_agent)}</p>` : ''}
        </li>`,
      )
      .join('');
    return `
      <section class="sup-inbox">
        <h2>${esc(t('sup.inbox'))} <span class="sup-count">${esc(t('sup.newCount', { n: box.new }))}</span></h2>
        ${box.items.length ? `<ol class="sup-list">${items}</ol>` : `<p class="muted">${esc(t('sup.empty'))}</p>`}
      </section>`;
  }
}
