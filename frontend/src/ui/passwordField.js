// Поле пароля с кнопкой «глаз»: показать / скрыть, что написано.
// Одна кнопка переключает все поля пароля в форме — «Пароль» и «Повторите пароль» видно вместе.

import { t } from '../i18n/i18n.js';

const EYE = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF = '<path d="M3 3l18 18M10.6 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.2M6.6 6.6A17 17 0 002 12s3.5 7 10 7a9.8 9.8 0 005.4-1.6M9.9 9.9a3 3 0 004.2 4.2"/>';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * HTML поля пароля с кнопкой.
 * @param {{name: string, autocomplete: string, attrs?: string}} opts attrs — доп. атрибуты input
 */
export function passwordField({ name, autocomplete, attrs = '' }) {
  return `
    <span class="pw-field">
      <input name="${name}" type="password" autocomplete="${autocomplete}" ${attrs} />
      <button type="button" class="pw-toggle" aria-pressed="false" aria-label="${esc(t('pf.showPassword'))}" title="${esc(t('pf.showPassword'))}">
        <svg viewBox="0 0 24 24" aria-hidden="true">${EYE}</svg>
      </button>
    </span>`;
}

/** Один обработчик на всю страницу: формы перерисовываются, кнопки появляются заново. */
export function initPasswordToggles() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.pw-toggle');
    if (!btn) return;
    const show = btn.getAttribute('aria-pressed') !== 'true';
    const scope = btn.closest('form') ?? btn.parentElement;
    scope.querySelectorAll('.pw-field').forEach((field) => {
      field.querySelector('input').type = show ? 'text' : 'password';
      const toggle = field.querySelector('.pw-toggle');
      const label = t(show ? 'pf.hidePassword' : 'pf.showPassword');
      toggle.setAttribute('aria-pressed', String(show));
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
      toggle.querySelector('svg').innerHTML = show ? EYE_OFF : EYE;
    });
    btn.previousElementSibling?.focus();
  });
}
