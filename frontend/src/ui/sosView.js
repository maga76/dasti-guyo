// Экран SOS: экстренные фразы для глухого человека — в магазине, на улице, в больнице.
// Нажал — фраза громко звучит (два раза) и показывается крупно на весь экран, чтобы помогли
// люди рядом. Сайт НИКУДА САМ НЕ ЗВОНИТ. Номер семьи (если человек его записал) показывается
// крупно — позвонить может любой рядом. Фразы — public/data/sos.json, голос заранее озвучен.

import { getLang, onLangChange, t } from '../i18n/i18n.js';
import { showBigText } from './bigText.js';
import { speakAndWait, stop as stopVoice } from '../speech/speech.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const PHONE_KEY = 'dasti-guyo:familyPhone';
const REPEAT = 2;

const ICONS = {
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z"/>',
  plus: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/>',
  phone: '<path d="M6 3h3l2 5-2 1.5a11 11 0 005.5 5.5L16 13l5 2v3a2 2 0 01-2 2A16 16 0 014 5a2 2 0 012-2z"/>',
  ear: '<path d="M8 15a5 5 0 1110 0c0 2-2 3-3 4s-1 2-3 2M3 3l18 18"/>',
  pin: '<path d="M12 21s-6-6-6-11a6 6 0 0112 0c0 5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5 5-2z"/>',
};

function readPhone() {
  try {
    return localStorage.getItem(PHONE_KEY) ?? '';
  } catch {
    return '';
  }
}

export class SosView {
  constructor() {
    this.root = $('sosRoot');
    this.phrases = [];
    this.active = false;
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('change', (e) => {
      if (e.target.id !== 'sosPhone') return;
      try {
        localStorage.setItem(PHONE_KEY, e.target.value.trim());
      } catch {
        /* номер просто не запомнится */
      }
      this.paint();
    });
    onLangChange(() => this.paint());
  }

  async setActive(active) {
    this.active = active;
    if (!active) return;
    if (!this.phrases.length) {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}data/sos.json`);
        this.phrases = (await res.json()).phrases;
      } catch {
        this.phrases = [];
      }
    }
    this.paint();
  }

  async onClick(e) {
    const btn = e.target.closest('[data-sos]');
    if (!btn) return;
    const p = this.phrases.find((x) => x.id === btn.dataset.sos);
    if (!p) return;
    const phone = p.id === 'family' ? readPhone() : '';
    const lang = getLang() === 'ru' ? 'ru' : 'tg';
    // Крупно: по-таджикски, перевод и (для семьи) номер — чтобы любой рядом мог позвонить
    showBigText([p.tj, lang === 'ru' ? p.ru : '', phone && `☎ ${phone}`].filter(Boolean).join('\n'));
    stopVoice();
    for (let i = 0; i < REPEAT; i++) {
      await speakAndWait(p.tj);
      if (document.getElementById('bigText').hidden) break; // закрыли экран — хватит
    }
  }

  paint() {
    if (!this.active) return;
    const phone = readPhone();
    this.root.innerHTML = `
      <header class="sos-head">
        <h1>${esc(t('sos.title'))}</h1>
        <p>${esc(t('sos.intro'))}</p>
      </header>
      <div class="sos-grid">
        ${this.phrases
          .map(
            (p) => `
          <button type="button" class="sos-btn is-${p.id}" data-sos="${p.id}">
            <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[p.icon] ?? ''}</svg>
            <b lang="tg">${esc(p.tj)}</b>
            <small>${esc(p.ru)}</small>
            ${p.id === 'family' && phone ? `<em>☎ ${esc(phone)}</em>` : ''}
          </button>`,
          )
          .join('')}
      </div>
      <label class="field sos-phone">${esc(t('sos.phone'))}
        <input id="sosPhone" type="tel" inputmode="tel" autocomplete="tel" maxlength="30" value="${esc(phone)}" placeholder="+992 …" />
        <small class="muted">${esc(t('sos.phoneHint'))}</small>
      </label>
      <p class="note sos-note">${esc(t('sos.noCall'))}</p>`;
  }
}
