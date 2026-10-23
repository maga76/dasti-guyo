// Обратное направление на экране «Тарҷума»: слышащий отвечает голосом или текстом —
// глухой видит ответ крупно на весь экран или жестами аватара.

import { getLang, onLangChange, t } from '../i18n/i18n.js';
import { showBigText } from './bigText.js';
import { Recognition, listen } from '../speech/recognition.js';

const $ = (id) => document.getElementById(id);

export class ReplyView {
  constructor() {
    this.session = null;
    this.status = null; // {key, kind} — чтобы перерисовать при смене языка

    $('micLang').value = getLang() === 'ru' ? 'ru-RU' : 'tg-TJ';
    $('btnReplyShow').addEventListener('click', () => showBigText($('replyText').value));
    $('btnReplyAvatar').addEventListener('click', () => {
      // Экран аватара сам возьмёт текст при открытии
      try {
        sessionStorage.setItem('dasti-guyo:avatarText', $('replyText').value);
      } catch {
        /* без sessionStorage аватар откроется без текста */
      }
      location.hash = '#/avatar';
    });
    $('replyText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        showBigText($('replyText').value);
      }
    });
    $('btnMic').addEventListener('click', () => (this.session ? this.session.stop() : this.start()));
    onLangChange(() => this.renderStatus());

    if (!Recognition) {
      $('btnMic').disabled = true;
      this.setStatus('tr.micUnsupported', 'error');
    }
  }

  setStatus(key, kind = '') {
    this.status = key ? { key, kind } : null;
    this.renderStatus();
  }

  renderStatus() {
    const el = $('replyStatus');
    el.textContent = this.status ? t(this.status.key) : '';
    el.classList.toggle('is-error', this.status?.kind === 'error');
    el.classList.toggle('is-ok', this.status?.kind === 'ok');
    $('btnMicLabel').textContent = t(this.session ? 'tr.micStop' : 'tr.mic');
  }

  start() {
    const before = $('replyText').value.trim();
    this.session = listen({
      lang: $('micLang').value,
      onText: (text, final) => {
        $('replyText').value = before ? `${before} ${text}` : text;
        if (final) showBigText($('replyText').value);
      },
      onError: (key, code) => {
        // Таджикский не поддерживается — сразу предлагаем русский
        if (code === 'language-not-supported') $('micLang').value = 'ru-RU';
        this.setStatus(key, 'error');
      },
      onEnd: () => {
        this.session = null;
        if (this.status?.key === 'tr.micListening') this.setStatus(null);
        this.renderStatus();
      },
    });
    if (this.session) this.setStatus('tr.micListening', 'ok');
  }
}
