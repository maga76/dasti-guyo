// Сообщение поверх видео: приветствие или понятная ошибка с кнопками.
// Тексты задаются ключами i18n, поэтому при смене языка сообщение перерисовывается.

import { onLangChange, t } from '../i18n/i18n.js';

const ICONS = {
  hand: '<svg viewBox="0 0 24 24"><path d="M8 13V5.5a1.5 1.5 0 013 0V11m0-6.5V4a1.5 1.5 0 013 0v7m0-5.5a1.5 1.5 0 013 0V12m0-3.5a1.5 1.5 0 013 0V15a7 7 0 01-7 7h-1a7 7 0 01-5.6-2.8L4 16.5a1.6 1.6 0 012.4-2L8 16"/></svg>',
  error: '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5M10.3 3.9L2.4 17.5A2 2 0 004.1 20.5h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><path d="M7 11V8a5 5 0 0110 0v3M6 11h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1v-8a1 1 0 011-1z"/></svg>',
  loading: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 109 9"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/></path></svg>',
};

const el = {
  root: document.getElementById('stageMessage'),
  icon: document.getElementById('msgIcon'),
  title: document.getElementById('msgTitle'),
  text: document.getElementById('msgText'),
  actions: document.getElementById('msgActions'),
};

let current = null;

/**
 * @param {object} msg
 * @param {'hand'|'error'|'lock'|'loading'} msg.icon
 * @param {string} msg.title ключ i18n
 * @param {string} [msg.text] ключ i18n
 * @param {object} [msg.params] параметры текста
 * @param {boolean} [msg.error]
 * @param {{label: string, primary?: boolean, onClick: () => void}[]} [msg.actions]
 */
export function showStageMessage(msg) {
  current = msg;
  render();
}

export function hideStageMessage() {
  current = null;
  el.root.hidden = true;
}

function render() {
  if (!current) return;
  const { icon, title, text, params = {}, error = false, actions = [] } = current;
  el.root.hidden = false;
  el.root.classList.toggle('is-error', error);
  el.icon.innerHTML = ICONS[icon] ?? '';
  el.title.textContent = t(title, params);
  el.text.textContent = text ? t(text, params) : '';
  el.text.hidden = !text;
  el.actions.replaceChildren(
    ...actions.map(({ label, primary, onClick }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${primary ? 'btn-primary btn-lg' : 'btn-secondary'}`;
      btn.textContent = t(label);
      btn.addEventListener('click', onClick);
      return btn;
    }),
  );
}

onLangChange(render);
