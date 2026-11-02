// Чат-бот «Ёрдамчӣ»: круглая кнопка в углу на всех страницах → окно переписки.
// Вопрос → ответ ИИ (сервер /chat, Google Gemini; ключ только на сервере).
// Голосовые сообщения — без ИИ: «Сделай голосом: Салом!» или кнопка «Голосом» у сообщения.
// Звук — с сервера /tts: таджикский текст — голос «Мадина», русский — русский голос.
// Переписка хранится только в этом браузере (localStorage).

import { config } from '../config.js';
import { api } from '../api/api.js';
import { getLang, onLangChange, t } from '../i18n/i18n.js';
import { listen, Recognition } from '../speech/recognition.js';
import { stop as stopVoice } from '../speech/speech.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STORE_KEY = 'dasti-guyo:chat';
const MAX_STORED = 40;
const CONTEXT = 12; // сколько последних сообщений бот видит, чтобы помнить разговор
const MAX_VOICE = 800; // столько букв сервер озвучивает за раз
const BARS = 28;

// Команды «сделай голосом». Сильные — в начале или в конце сообщения;
// слабые («голосом», «бо овоз») — только через двоеточие, запятую или тире («Голосом: …»,
// «Салом — бо овоз»), чтобы вопрос «как работает перевод голосом?» не стал голосовым
const STRONG = [
  'сделай голосовое сообщение', 'зделай голосовое сообщение', 'сделай голосовое', 'зделай голосовое',
  'сделай это голосом', 'зделай это голосом', 'сделай голосом', 'зделай голосом', 'скажи это голосом',
  'скажи голосом', 'озвучь это', 'озвучь', 'прочитай вслух', 'инро бо овоз гӯй', 'бо овоз гӯй',
  'бо овоз хон', 'овозӣ кун', 'овоз кун', 'паёми овозӣ кун',
];
const WEAK = ['голосовое сообщение', 'голосом', 'бо овоз', 'паёми овозӣ'];
const SEP = /^[\s:,\-—–«»"']+|[\s:,\-—–«»"']+$/g; // края текста для озвучки: точку и «?» оставляем
const FILLER = /^(это|мне|инро|ин)\s+/i;
const letters = (s) => (/[\p{L}\d]/u.test(s) ? s : ''); // «.» без слов — озвучивать нечего

/** «Сделай голосом: Салом» → {payload: 'Салом'}; «сделай это голосом» → {payload: ''}; иначе null. */
export function parseVoiceCommand(raw) {
  if (/\?\s*$/.test(raw) && !/^\s*\S+[^:]*:/.test(raw)) return null; // вопрос — это вопрос к ИИ
  const text = raw.trim();
  const low = text.toLowerCase();
  const all = [...STRONG.map((c) => [c, true]), ...WEAK.map((c) => [c, false])].sort((a, b) => b[0].length - a[0].length);
  for (const [cmd, strong] of all) {
    const head = low.replace(/^[\s«"']+/, '');
    if (head.startsWith(cmd)) {
      const rest = text.slice(text.length - head.length + cmd.length);
      if (rest && !/^[\s:,.!\-—–]/.test(rest)) continue; // «голосовой» — не команда
      if (!strong && rest.trim() && !/^\s*[:\-—–]/.test(rest)) continue;
      return { payload: letters(rest.replace(SEP, '').replace(FILLER, '').replace(SEP, '')) };
    }
    const tail = low.replace(/[\s.!»"']+$/, '');
    if (tail.endsWith(cmd)) {
      const rest = text.slice(0, tail.length - cmd.length);
      if (rest && !/[\s:,.!\-—–]$/.test(rest)) continue;
      if (!strong && rest.trim() && !/[,:\-—–]\s*$/.test(rest)) continue;
      return { payload: letters(rest.replace(SEP, '').replace(/\s+(это|инро)$/i, '').replace(SEP, '')) };
    }
  }
  return null;
}

// Таджикские буквы → «Мадина»; буквы, которых нет в таджикском, → русский голос
const TAJIK = /[ӣӯҳқғҷӢӮҲҚҒҶ]/;
const RUSSIAN_ONLY = /[ыщцьЫЩЦЬ]/;
export function voiceFor(text) {
  if (TAJIK.test(text)) return 'madina';
  if (RUSSIAN_ONLY.test(text)) return 'ru';
  return getLang() === 'ru' ? 'ru' : 'madina';
}

const ICON = {
  chat: '<path d="M4 5h16v11H9l-5 4V5z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01" stroke-width="2.6"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5L4 12z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>',
  play: '<path d="M8 5l11 7-11 7V5z" fill="currentColor"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>',
  voice: '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

function load() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((m) => m && typeof m.text === 'string') : [];
  } catch {
    return [];
  }
}

// Одинаковая «волна» для одного и того же текста — как у настоящих голосовых
function bars(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Array.from({ length: BARS }, (_, i) => {
    h = (h * 1103515245 + 12345) >>> 0;
    const edge = Math.sin((Math.PI * (i + 0.5)) / BARS); // тише по краям
    return Math.round(22 + 78 * edge * (0.35 + ((h >>> 16) % 100) / 154));
  });
}

const clock = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class ChatView {
  constructor() {
    this.messages = load();
    this.audio = new Map(); // голос|текст → Promise<blob-адрес>
    this.ready = new Map(); // голос|текст → готовый blob-адрес (для ссылки «Скачать»)
    this.player = null; // {audio, el}
    this.busy = false;
    this.enabled = null; // null — ещё не спрашивали сервер
    this.mic = null;
    this.build();
    onLangChange(() => this.paintStatic());
  }

  build() {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<button type="button" class="chat-fab" id="chatFab" aria-haspopup="dialog" aria-expanded="false">
        ${svg('chat')}<span class="chat-fab-dot" aria-hidden="true"></span>
      </button>
      <section class="chat-panel" id="chatPanel" role="dialog" aria-modal="false" aria-labelledby="chatTitle" hidden>
        <header class="chat-head">
          <span class="chat-ava">${svg('spark')}</span>
          <div class="chat-head-text"><b id="chatTitle"></b><small id="chatSub"></small></div>
          <button type="button" class="chat-icon" id="chatClear">${svg('trash')}</button>
          <button type="button" class="chat-icon" id="chatClose">${svg('close')}</button>
        </header>
        <div class="chat-log" id="chatLog" aria-live="polite"></div>
        <form class="chat-form" id="chatForm">
          <button type="button" class="chat-icon chat-mic" id="chatMic">${svg('mic')}</button>
          <textarea id="chatInput" rows="1" maxlength="2000"></textarea>
          <button type="submit" class="chat-send" id="chatSend">${svg('send')}</button>
        </form>
      </section>`,
    );
    const $ = (id) => document.getElementById(id);
    this.fab = $('chatFab');
    this.panel = $('chatPanel');
    this.log = $('chatLog');
    this.input = $('chatInput');
    this.fab.addEventListener('click', () => this.open(true));
    $('chatClose').addEventListener('click', () => this.open(false));
    $('chatClear').addEventListener('click', () => this.clear());
    $('chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.send(this.input.value);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send(this.input.value);
      }
    });
    this.input.addEventListener('input', () => this.autosize());
    $('chatMic').addEventListener('click', () => this.listen());
    $('chatMic').hidden = !Recognition;
    this.log.addEventListener('click', (e) => this.onLogClick(e));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.panel.hidden) this.open(false);
    });
    this.paintStatic();
  }

  paintStatic() {
    const set = (id, key) => (document.getElementById(id).textContent = t(key));
    set('chatTitle', 'chat.title');
    set('chatSub', 'chat.sub');
    this.fab.setAttribute('aria-label', t('chat.open'));
    this.fab.title = t('chat.open');
    for (const [id, key] of [['chatClear', 'chat.clear'], ['chatClose', 'chat.close'], ['chatMic', 'chat.mic'], ['chatSend', 'chat.send']]) {
      const el = document.getElementById(id);
      el.setAttribute('aria-label', t(key));
      el.title = t(key);
    }
    this.input.placeholder = t('chat.placeholder');
    if (!this.panel.hidden) this.render();
  }

  open(on) {
    this.panel.hidden = !on;
    this.fab.hidden = on;
    this.fab.setAttribute('aria-expanded', String(on));
    document.body.classList.toggle('chat-open', on);
    if (!on) {
      this.pause();
      this.mic?.stop();
      this.fab.focus();
      return;
    }
    this.fab.classList.add('seen'); // точка «новое» больше не нужна
    this.render();
    this.input.focus();
    if (this.enabled === null) {
      api('/chat/status', { timeout: 8000 })
        .then((r) => (this.enabled = Boolean(r?.enabled)))
        .catch(() => (this.enabled = null))
        .finally(() => this.render());
    }
  }

  autosize() {
    this.input.style.height = 'auto';
    const full = this.input.scrollHeight;
    this.input.style.height = `${Math.min(full, 140)}px`;
    this.input.style.overflowY = full > 140 ? 'auto' : 'hidden'; // полоса прокрутки — только для длинного текста
  }

  save() {
    this.messages = this.messages.slice(-MAX_STORED);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.messages.filter((m) => !m.error)));
    } catch {
      /* переписка просто не запомнится */
    }
  }

  push(msg) {
    this.messages.push(msg);
    this.save();
    this.render();
    return msg;
  }

  clear() {
    this.pause();
    this.messages = [];
    this.save();
    this.render();
  }

  // ---------- Отправка ----------

  async send(raw) {
    const text = raw.trim();
    if (!text || this.busy) return;
    this.input.value = '';
    this.autosize();
    this.push({ role: 'user', text });

    const cmd = parseVoiceCommand(text);
    if (cmd) {
      const payload = cmd.payload || this.lastText();
      if (!payload) this.push({ role: 'bot', text: t('chat.voiceWhat') });
      else this.makeVoice(payload);
      return;
    }
    await this.ask();
  }

  /** Последний текст для «сделай это голосом» без текста: ответ бота, иначе своё сообщение. */
  lastText() {
    const prev = this.messages.slice(0, -1).reverse();
    const pick = prev.find((m) => m.role === 'bot' && !m.error && !m.voice) ?? prev.find((m) => m.role === 'user' && !parseVoiceCommand(m.text));
    return pick?.text ?? '';
  }

  async ask() {
    this.busy = true;
    this.render();
    const history = this.messages
      .filter((m) => !m.error)
      .slice(-CONTEXT)
      .map((m) => ({ role: m.role, text: m.text.slice(0, 2000) }));
    // Gemini ждёт, что переписка начинается с человека
    while (history.length && history[0].role !== 'user') history.shift();
    try {
      const res = await api('/chat', { method: 'POST', body: { messages: history }, timeout: 60_000 });
      this.enabled = true;
      this.busy = false;
      this.push({ role: 'bot', text: res.reply });
    } catch (err) {
      if (err.code === 'chat_disabled') this.enabled = false;
      this.busy = false;
      this.push({ role: 'bot', text: err.message, error: true });
    }
  }

  makeVoice(text) {
    const msg = this.push({ role: 'bot', voice: true, text: text.slice(0, MAX_VOICE) });
    this.play(this.messages.indexOf(msg)); // сразу звучит — как будто прислали голосовое
  }

  // ---------- Голосовые ----------

  audioUrl(text) {
    const voice = voiceFor(text);
    const key = `${voice}|${text}`;
    if (!this.audio.has(key)) {
      const url = `${config.apiUrl}/tts?voice=${voice}&text=${encodeURIComponent(text)}`;
      const promise = fetch(url, { signal: AbortSignal.timeout(45_000) })
        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
        .then((blob) => URL.createObjectURL(blob));
      promise.then((u) => this.ready.set(key, u));
      promise.catch(() => this.audio.delete(key)); // в следующий раз попробуем снова
      this.audio.set(key, promise);
    }
    return this.audio.get(key);
  }

  async play(index) {
    const msg = this.messages[index];
    if (!msg) return;
    if (this.player?.index === index) {
      const a = this.player.audio;
      if (a.paused) a.play().catch(() => {});
      else a.pause();
      return;
    }
    this.pause();
    stopVoice(); // другие голоса сайта замолкают
    const el = () => this.log.querySelector(`[data-index="${index}"]`);
    el()?.classList.add('is-loading');
    let url;
    try {
      url = await this.audioUrl(msg.text);
    } catch {
      el()?.classList.remove('is-loading');
      this.push({ role: 'bot', text: t('chat.voiceFail'), error: true });
      return;
    }
    const audio = new Audio(url);
    this.player = { index, audio };
    const paint = () => {
      const box = el();
      if (!box) return;
      box.classList.remove('is-loading');
      box.classList.toggle('is-playing', !audio.paused);
      const progress = audio.duration ? audio.currentTime / audio.duration : 0;
      box.querySelectorAll('.vm-wave i').forEach((bar, i) => bar.classList.toggle('on', i < Math.round(progress * BARS)));
      box.querySelector('.vm-time').textContent = clock(audio.paused && !audio.currentTime ? audio.duration : audio.currentTime);
      box.querySelector('.vm-play').innerHTML = svg(audio.paused ? 'play' : 'pause');
      const link = box.querySelector('.vm-dl');
      link.href = url;
      link.hidden = false;
    };
    for (const ev of ['play', 'pause', 'timeupdate']) audio.addEventListener(ev, paint);
    audio.addEventListener('loadedmetadata', () => {
      // Длительность запоминаем — у голосового всегда видно, сколько оно длится
      if (Number.isFinite(audio.duration)) msg.duration = audio.duration;
      this.save();
      paint();
    });
    audio.addEventListener('ended', () => {
      audio.currentTime = 0;
      paint();
    });
    audio.play().catch(paint);
  }

  pause() {
    this.player?.audio.pause();
    this.player = null;
  }

  onLogClick(e) {
    const play = e.target.closest('.vm-play');
    if (play) return this.play(Number(play.closest('[data-index]').dataset.index));
    const toVoice = e.target.closest('[data-voice]');
    if (toVoice) return this.makeVoice(this.messages[Number(toVoice.dataset.voice)].text);
    const tip = e.target.closest('[data-tip]');
    if (tip) this.send(tip.dataset.tip);
  }

  listen() {
    if (this.mic) return this.mic.stop();
    const btn = document.getElementById('chatMic');
    const base = this.input.value.trim();
    this.mic = listen({
      lang: getLang() === 'ru' ? 'ru-RU' : 'tg-TJ',
      onText: (text, final) => {
        this.input.value = base ? `${base} ${text}` : text;
        this.autosize();
        if (final) this.mic?.stop();
      },
      onError: (key) => this.push({ role: 'bot', text: t(key), error: true }),
      onEnd: () => {
        this.mic = null;
        btn.classList.remove('is-on');
      },
    });
    btn.classList.toggle('is-on', Boolean(this.mic));
  }

  // ---------- Отрисовка ----------

  render() {
    if (this.panel.hidden) return;
    const playing = this.player?.index;
    const tips = ['chat.tip1', 'chat.tip2', 'chat.tip3'].map((k) => t(k));
    const hello = `
      <div class="chat-msg bot">
        <div class="chat-bubble">${esc(t('chat.hello'))}</div>
      </div>
      ${this.enabled === false ? `<p class="chat-note">${esc(t('chat.offNote'))}</p>` : ''}
      ${this.messages.length ? '' : `<div class="chat-tips">${tips.map((x) => `<button type="button" data-tip="${esc(x)}">${esc(x)}</button>`).join('')}</div>`}`;
    const items = this.messages.map((m, i) => {
      if (m.voice) {
        const ready = this.ready.get(`${voiceFor(m.text)}|${m.text}`);
        return `
        <div class="chat-msg bot">
          <div class="chat-bubble vm${playing === i ? ' is-playing' : ''}" data-index="${i}">
            <div class="vm-row">
              <button type="button" class="vm-play" aria-label="${esc(t('chat.play'))}">${svg('play')}</button>
              <span class="vm-wave" aria-hidden="true">${bars(m.text).map((h) => `<i style="height:${h}%"></i>`).join('')}</span>
              <span class="vm-time">${clock(m.duration)}</span>
              <a class="vm-dl" download="dasti-guyo-ovoz.mp3" title="${esc(t('chat.download'))}" aria-label="${esc(t('chat.download'))}"${ready ? ` href="${ready}"` : ' hidden'}>${svg('download')}</a>
            </div>
            <p class="vm-text">${esc(m.text)}</p>
          </div>
        </div>`;
      }
      const action =
        !m.error && m.text.length <= MAX_VOICE && !(m.role === 'user' && parseVoiceCommand(m.text))
          ? `<button type="button" class="chat-act" data-voice="${i}">${svg('voice')}${esc(t('chat.toVoice'))}</button>`
          : '';
      return `
        <div class="chat-msg ${m.role}${m.error ? ' is-error' : ''}">
          <div class="chat-bubble">${esc(m.text).replace(/\n/g, '<br>')}</div>
          ${action}
        </div>`;
    });
    const typing = this.busy ? '<div class="chat-msg bot"><div class="chat-bubble chat-typing"><i></i><i></i><i></i></div></div>' : '';
    this.log.innerHTML = hello + items.join('') + typing;
    document.getElementById('chatSend').disabled = this.busy;
    // Проигрываемое голосовое после перерисовки — снова с кнопкой «пауза» и ссылкой «скачать»
    if (this.player) this.player.audio.dispatchEvent(new Event('timeupdate'));
    this.log.scrollTop = this.log.scrollHeight;
  }
}
