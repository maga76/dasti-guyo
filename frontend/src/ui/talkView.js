// Экран «Сӯҳбат» (разговор): глухой и слышащий говорят через один экран.
//   - Глухой показывает жесты в камеру → помощник собирает предложение (translateView + grammar.js) →
//     после паузы оно появляется в чате и звучит голосом «Мадина».
//   - Слышащий говорит в микрофон или пишет → сообщение в чате крупно, и 3D-аватар сразу
//     показывает его жестами (сцена аватара на время разговора переезжает на этот экран).

import { getLang, onLangChange, t } from '../i18n/i18n.js';
import { Recognition, listen } from '../speech/recognition.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MAX_MESSAGES = 30;

export class TalkView {
  /**
   * @param {object} deps
   * @param {import('./translateView.js').TranslateView} deps.translateView
   * @param {import('./avatarView.js').AvatarView} deps.avatarView
   * @param {() => boolean} deps.isCameraOn
   * @param {() => void} deps.startCamera
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.messages = [];
    this.session = null;
    this.active = false;
    this.avatarHome = null; // где сцена аватара живёт обычно (экран «Ба имо»)

    $('talkLang').value = getLang() === 'ru' ? 'ru-RU' : 'tg-TJ';
    $('talkMic').addEventListener('click', () => (this.session ? this.session.stop() : this.listen()));
    $('talkForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.hearing($('talkInput').value);
      $('talkInput').value = '';
    });
    $('talkClear').addEventListener('click', () => {
      this.messages = [];
      this.paintMessages();
    });
    $('talkCamera').addEventListener('click', () => this.startCamera());
    $('talkFeed').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-replay]');
      if (btn) this.avatarView.say(this.messages[Number(btn.dataset.replay)].text);
    });
    // Глухой: предложение готово и произнесено — в чат
    this.translateView.onSentenceSpoken = (s) => {
      if (this.active) this.add({ who: 'deaf', text: s.tj, sub: s.ru !== s.tj ? s.ru : '' });
    };
    // Пока человек показывает жесты — видно, что уже понято
    this.translateView.onSentenceChange = () => this.active && this.paintLive();
    onLangChange(() => this.active && this.paint());
    if (!Recognition) $('talkMic').disabled = true;
  }

  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    this.translateView.talkMode = active;
    this.moveAvatar(active);
    if (!active) this.session?.stop();
    else this.paint();
  }

  /** Сцена аватара переезжает сюда на время разговора и возвращается обратно. */
  moveAvatar(here) {
    const stage = $('avStage');
    if (here) {
      this.avatarHome ??= { parent: stage.parentElement, next: stage.nextSibling };
      $('talkAvatar').append(stage);
    } else if (this.avatarHome) {
      this.avatarHome.parent.insertBefore(stage, this.avatarHome.next);
    }
  }

  /** Слышащий сказал или написал — в чат и жестами аватара. */
  hearing(text) {
    const clean = text?.trim();
    if (!clean) return;
    this.add({ who: 'hearing', text: clean });
    this.avatarView.say(clean);
  }

  add(message) {
    this.messages.push({ ...message, at: new Date() });
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();
    this.paintMessages();
  }

  listen() {
    let heard = '';
    this.session = listen({
      lang: $('talkLang').value,
      onText: (text, final) => {
        heard = text;
        $('talkInput').value = text;
        if (final) this.session?.stop();
      },
      onError: (key, code) => {
        // Таджикский распознаватель есть не везде — сразу переключаем на русский
        if (code === 'language-not-supported') $('talkLang').value = 'ru-RU';
        $('talkStatus').textContent = t(key);
      },
      onEnd: () => {
        this.session = null;
        $('talkInput').value = '';
        this.hearing(heard);
        this.paintMic();
      },
    });
    $('talkStatus').textContent = '';
    this.paintMic();
  }

  paint() {
    this.paintMic();
    this.paintLive();
    this.paintMessages();
  }

  paintMic() {
    $('talkMic').classList.toggle('is-listening', Boolean(this.session));
    $('talkMicLabel').textContent = t(this.session ? 'talk.listening' : 'talk.speak');
  }

  /** Что сейчас показывает глухой: жесты и собранное из них предложение. */
  paintLive() {
    const tv = this.translateView;
    const words = tv.words;
    $('talkCamera').hidden = this.isCameraOn();
    $('talkLiveWords').replaceChildren(...words.map((w) => Object.assign(document.createElement('span'), { textContent: w })));
    $('talkLiveText').textContent = words.length ? tv.sentence().tj : t(this.isCameraOn() ? 'talk.showSigns' : 'talk.cameraOff');
    $('talkLive').classList.toggle('is-empty', !words.length);
  }

  paintMessages() {
    const time = (d) => d.toLocaleTimeString(getLang() === 'ru' ? 'ru-RU' : 'tg-TJ', { hour: '2-digit', minute: '2-digit' });
    const feed = $('talkFeed');
    feed.innerHTML = this.messages.length
      ? this.messages
          .map(
            (m, i) => `
        <li class="talk-msg is-${m.who}">
          <span class="talk-who">${esc(t(m.who === 'deaf' ? 'talk.deaf' : 'talk.hearing'))} · ${esc(time(m.at))}</span>
          <p lang="${m.who === 'deaf' ? 'tg' : ''}">${esc(m.text)}</p>
          ${m.sub ? `<small>${esc(m.sub)}</small>` : ''}
          ${m.who === 'hearing' ? `<button type="button" class="talk-replay" data-replay="${i}">${esc(t('talk.replay'))}</button>` : ''}
        </li>`,
          )
          .join('')
      : `<li class="talk-empty">${esc(t('talk.empty'))}</li>`;
    feed.scrollTop = feed.scrollHeight;
  }
}
