// Экран «Ба имо»: слышащий говорит или пишет — 3D-аватар показывает это жестами.
//
// Откуда жесты: записи движений рук из набора Slovo (базовый словарь) и записи
// пользователя из раздела «Омӯзиш» (их аватар тоже умеет показывать; свои — важнее).
// Three.js и модель грузятся только при первом открытии экрана.

import { getLang, onLangChange, t } from '../i18n/i18n.js';
import { NONE_LABEL, getAllSamples } from '../dataset/dataset.js';
import { loadBaseDataset } from '../dataset/baseDataset.js';
import { textToSigns } from '../avatar/lexicon.js';
import { Recognition, listen } from '../speech/recognition.js';
import { labelName } from './trainView.js';

const $ = (id) => document.getElementById(id);
const PENDING_KEY = 'dasti-guyo:avatarText';
const EXAMPLES = ['Салом, дӯстам!', 'Ман об мехоҳам', 'Модар дар хона', 'Ташаккур, хуб', 'Имрӯз ба мактаб', 'Ба ман ёрӣ диҳед'];

export class AvatarView {
  constructor() {
    this.stage = null;
    this.loading = null;
    this.reps = new Map(); // жест → кадры записи
    this.tokens = [];
    this.lastText = '';
    this.session = null;
    this.status = null;
    this.active = false;

    $('avLang').value = getLang() === 'ru' ? 'ru-RU' : 'tg-TJ';
    $('avGo').addEventListener('click', () => this.translate($('avText').value));
    $('avText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.translate($('avText').value);
      }
    });
    $('avReplay').addEventListener('click', () => this.translate(this.lastText));
    $('avMic').addEventListener('click', () => (this.session ? this.session.stop() : this.listen()));
    $('avExamples').replaceChildren(...EXAMPLES.map((text) => this.chip(text, () => this.say(text))));
    $('avKnown').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-label]');
      if (btn) this.say(labelName(btn.dataset.label));
    });
    document.querySelectorAll('.av-speed button').forEach((btn) =>
      btn.addEventListener('click', () => {
        document.querySelectorAll('.av-speed button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        this.stage?.setSpeed(Number(btn.dataset.speed));
      }),
    );
    if (!Recognition) {
      $('avMic').disabled = true;
      this.setStatus('tr.micUnsupported', 'error');
    }
    onLangChange(() => {
      this.renderStatus();
      this.renderMic();
      if (!this.stage?.player?.playing) this.renderIdleCaption();
    });
    this.renderMic();
    this.renderIdleCaption();
  }

  chip(text, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'av-chip';
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  async setActive(active) {
    this.active = active;
    if (!active) {
      this.stage?.setActive(false);
      this.session?.stop();
      return;
    }
    await this.ensureLoaded();
    if (!this.active || !this.stage) return;
    this.stage.setActive(true);
    // Текст, присланный с экрана «Тарҷума»
    let pending = null;
    try {
      pending = sessionStorage.getItem(PENDING_KEY);
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* без sessionStorage — просто нет текста */
    }
    if (pending?.trim()) this.say(pending);
  }

  /** Загрузить Three.js, модель и записи жестов (один раз). */
  ensureLoaded() {
    this.loading ??= (async () => {
      const loader = $('avLoader');
      const text = $('avLoaderText');
      const progress = (p) => (text.textContent = t('av.loading', { percent: Math.round(p * 100) }));
      progress(0);
      try {
        const [{ AvatarStage }, { pickRepresentatives }, base, own] = await Promise.all([
          import('../avatar/avatarStage.js'),
          import('../avatar/signPlayer.js'),
          loadBaseDataset(),
          getAllSamples(),
        ]);
        // Свои записи (например, таджикские жесты, записанные с носителями языка) важнее базовых
        this.reps = pickRepresentatives(base?.samples ?? []);
        for (const [label, frames] of pickRepresentatives(own.filter((s) => s.label !== NONE_LABEL))) {
          this.reps.set(label, frames);
        }
        this.vocabulary = new Map((base?.vocabulary ?? []).map((v) => [v.label, v]));
        this.renderKnown();

        const { drawHandInset } = await import('../avatar/handInset.js');
        const stage = new AvatarStage($('avCanvas'));
        await stage.load(progress);
        // Схема рук рядом с аватаром — каждый кадр, в той же позе
        stage.onPose = (pose) => drawHandInset($('avInset'), pose);
        this.stage = stage;
        loader.hidden = true;
      } catch (err) {
        console.error('[avatar] Не загрузился:', err);
        text.textContent = t('av.loadError');
        loader.classList.add('is-error');
      }
    })();
    return this.loading;
  }

  renderKnown() {
    $('avKnown').replaceChildren(
      ...[...this.reps.keys()].map((label) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'av-chip';
        btn.dataset.label = label;
        btn.textContent = labelName(label);
        return btn;
      }),
    );
  }

  /** Вставить текст в поле и показать жестами. */
  say(text) {
    $('avText').value = text;
    this.translate(text);
  }

  async translate(text) {
    if (!text?.trim()) return;
    await this.ensureLoaded();
    if (!this.stage) return;
    this.lastText = text;
    this.tokens = textToSigns(text, new Set(this.reps.keys()));
    const items = [];
    this.tokens.forEach((token, i) => {
      if (token.label) items.push({ label: token.label, frames: this.reps.get(token.label), token: i });
    });
    this.renderTokens(-1);
    $('avReplay').disabled = false;

    if (!items.length) {
      this.setStatus('av.nothing', 'error');
      this.renderIdleCaption();
      return;
    }
    this.setStatus(this.tokens.some((tk) => !tk.label) ? 'av.unknown' : null);
    this.stage.play(items, {
      onWord: (i) => {
        const token = items[i].token;
        this.renderTokens(token);
        $('avWord').textContent = labelName(items[i].label);
        $('avWord').classList.remove('is-idle');
      },
      onEnd: () => {
        this.renderTokens(this.tokens.length);
        $('avWord').textContent = text;
        $('avWord').classList.add('is-done');
      },
    });
    $('avWord').classList.remove('is-done');
  }

  /** Субтитры: пройденные слова, текущее (золотом), будущие и слова без жеста (бледные). */
  renderTokens(current) {
    $('avTokens').replaceChildren(
      ...this.tokens.map((token, i) => {
        const span = document.createElement('span');
        span.className = `av-token${token.label ? '' : ' is-unknown'}${i === current ? ' is-current' : ''}${i < current ? ' is-done' : ''}`;
        span.textContent = token.word;
        return span;
      }),
    );
  }

  renderIdleCaption() {
    const word = $('avWord');
    word.textContent = t('av.idle');
    word.classList.add('is-idle');
  }

  // ---------- Микрофон ----------

  listen() {
    this.session = listen({
      lang: $('avLang').value,
      onText: (text, final) => {
        $('avText').value = text;
        if (final) this.translate(text);
      },
      onError: (key, code) => {
        if (code === 'language-not-supported') $('avLang').value = 'ru-RU';
        this.setStatus(key, 'error');
      },
      onEnd: () => {
        this.session = null;
        this.renderMic();
        if (this.status?.key === 'tr.micListening') this.setStatus(null);
      },
    });
    if (this.session) this.setStatus('tr.micListening', 'ok');
    this.renderMic();
  }

  renderMic() {
    $('avMic').classList.toggle('is-listening', Boolean(this.session));
    $('avMicLabel').textContent = t(this.session ? 'av.listening' : 'av.speak');
  }

  setStatus(key, kind = '') {
    this.status = key ? { key, kind } : null;
    this.renderStatus();
  }

  renderStatus() {
    const el = $('avStatus');
    el.textContent = this.status ? t(this.status.key) : '';
    el.classList.toggle('is-error', this.status?.kind === 'error');
    el.classList.toggle('is-ok', this.status?.kind === 'ok');
  }
}
