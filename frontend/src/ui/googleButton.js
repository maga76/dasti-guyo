// Кнопка «Продолжить с Google» (Google Identity Services). Google сам рисует кнопку и окно
// выбора аккаунта, а нам отдаёт «пропуск» (ID token) — его проверяет наш сервер (/auth/google).
// Кнопка появляется, только если на сервере задан GOOGLE_CLIENT_ID.

import { getAuthOptions } from '../api/api.js';

const SCRIPT_URL = 'https://accounts.google.com/gsi/client';
let scriptPromise = null;
let initializedFor = null;
let onCredential = null;

function loadScript() {
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve(window.google);
    script.onerror = () => {
      scriptPromise = null; // нет связи с Google — попробуем при следующем показе формы
      script.remove();
      reject(new Error('google script'));
    };
    document.head.append(script);
  });
  return scriptPromise;
}

/**
 * Нарисовать кнопку Google в контейнере. Если вход через Google выключен или Google
 * недоступен — контейнер остаётся скрытым.
 * @param {HTMLElement} container
 * @param {{lang: string, dark: boolean, onCredential: (credential: string) => void, beforeShow?: () => void}} opts
 *   beforeShow — показать место под кнопку (ширину кнопки Google берёт из ширины контейнера)
 * @returns {Promise<boolean>} показана ли кнопка
 */
export async function renderGoogleButton(container, opts) {
  const { google_client_id: clientId } = await getAuthOptions();
  if (!clientId || !container.isConnected) return false;
  let google;
  try {
    google = await loadScript();
  } catch {
    return false;
  }
  onCredential = opts.onCredential;
  if (initializedFor !== clientId) {
    google.accounts.id.initialize({
      client_id: clientId,
      callback: (res) => onCredential?.(res.credential),
      ux_mode: 'popup',
      use_fedcm_for_button: true,
    });
    initializedFor = clientId;
  }
  if (!container.isConnected) return false; // форма уже перерисована
  opts.beforeShow?.();
  google.accounts.id.renderButton(container, {
    type: 'standard',
    theme: opts.dark ? 'filled_black' : 'outline',
    size: 'large',
    text: 'continue_with',
    shape: 'pill',
    logo_alignment: 'center',
    width: Math.min(400, Math.max(200, Math.round(container.clientWidth || 320))),
    locale: opts.lang === 'ru' ? 'ru' : 'tg',
  });
  return true;
}
