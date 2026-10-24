// Связь с бэкендом: регистрация, вход по логину и паролю, запросы с токеном, понятные ошибки.
// Токен хранится в localStorage — человек остаётся в своём профиле, пока токен не устареет
// (12 часов) или пока не нажмёт «Выйти».

import { config } from '../config.js';
import { getLang } from '../i18n/i18n.js';

const TOKEN_KEY = 'dasti-guyo:token';
const USER_KEY = 'dasti-guyo:user';
const listeners = new Set();

export class ApiError extends Error {
  constructor(status, body) {
    const text = body?.message?.[getLang() === 'ru' ? 'ru' : 'tg'] ?? body?.message?.ru ?? `HTTP ${status}`;
    super(text);
    this.status = status;
    this.code = body?.code ?? 'network';
    this.errors = body?.errors;
  }
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getToken() {
  const token = storage()?.getItem(TOKEN_KEY) ?? null;
  // Устаревший токен убираем сразу, чтобы не показывать «вы вошли», когда это уже не так
  if (token && tokenExpired(token)) {
    storage()?.removeItem(TOKEN_KEY);
    storage()?.removeItem(USER_KEY);
    return null;
  }
  return token;
}

function tokenExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

/** Текущий пользователь {id, username, role} или null. */
export function getUser() {
  if (!getToken()) return null;
  try {
    return JSON.parse(storage()?.getItem(USER_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export const isAdmin = () => getUser()?.role === 'admin';

/** Подписка на вход/выход. */
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setSession(token, user) {
  if (token) {
    storage()?.setItem(TOKEN_KEY, token);
    storage()?.setItem(USER_KEY, JSON.stringify(user));
  } else {
    storage()?.removeItem(TOKEN_KEY);
    storage()?.removeItem(USER_KEY);
  }
  listeners.forEach((fn) => fn(user));
}

/**
 * Запрос к API.
 * @param {string} path например '/gestures'
 * @param {{method?: string, body?: any, form?: FormData|URLSearchParams, timeout?: number}} [opts]
 */
export async function api(path, { method = 'GET', body, form, timeout = 20_000 } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers,
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new ApiError(0, { code: 'network', message: { tg: 'Сервер дастрас нест.', ru: 'Сервер недоступен.' } });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Токен устарел — выходим, чтобы не показывать чужие ошибки на каждом шаге
    if (res.status === 401 && token) setSession(null, null);
    throw new ApiError(res.status, data);
  }
  return data;
}

export async function login(username, password) {
  const form = new URLSearchParams({ username, password });
  const data = await api('/auth/login', { method: 'POST', form });
  setSession(data.access_token, data.user);
  return data.user;
}

/** Регистрация (роль — волонтёр) и сразу вход. */
export async function register(username, password) {
  const data = await api('/auth/register', { method: 'POST', body: { username, password } });
  setSession(data.access_token, data.user);
  return data.user;
}

export function logout() {
  setSession(null, null);
}

/** Доступен ли сервер (быстрая проверка). */
export async function isServerUp() {
  try {
    const res = await fetch(`${config.apiUrl}/health`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}
