// Экран «Дар бораи лоиҳа» (о проекте): коротко для защиты и для гостей — какую проблему решаем,
// что умеет сайт, как он устроен, честные цифры точности и что дальше. QR-код — открыть сайт на
// своём телефоне; кнопка — установить как приложение. Цифры — из отчётов моделей (metrics).

import { onLangChange, t } from '../i18n/i18n.js';
import { loadBaseMetrics } from '../dataset/baseDataset.js';
import { assetUrls, downloadJson } from '../net/download.js';
import { install, installState, onInstallChange } from './pwa.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

const FEATURES = [
  ['#/', 'nav.translate', 'about.f.translate'],
  ['#/talk', 'nav.talk', 'about.f.talk'],
  ['#/avatar', 'nav.avatar', 'about.f.avatar'],
  ['#/sos', 'about.f.sosTitle', 'about.f.sos'],
  ['#/train', 'nav.train', 'about.f.train'],
  ['#/speech', 'nav.speech', 'about.f.speech'],
  ['#/practice', 'nav.practice', 'about.f.practice'],
  ['#/model', 'nav.model', 'about.f.model'],
];
const STEPS = ['about.step1', 'about.step2', 'about.step3', 'about.step4', 'about.step5'];

export class AboutView {
  constructor() {
    this.root = $('aboutRoot');
    this.active = false;
    this.metrics = null;
    this.seq = null;
    this.root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-act="install"]')) await install();
    });
    onLangChange(() => this.paint());
    onInstallChange(() => this.paint());
  }

  async setActive(active) {
    this.active = active;
    if (!active) return;
    this.paint();
    if (!this.metrics) {
      const [metrics, seq] = await Promise.all([
        loadBaseMetrics().catch(() => null),
        downloadJson(assetUrls('models/seq/model.json')).catch(() => null),
      ]);
      this.metrics = metrics;
      this.seq = seq?.metrics ?? null;
      this.paint();
    }
  }

  installHtml() {
    const state = installState();
    if (state === 'installed') return `<p class="about-installed">${esc(t('about.installed'))}</p>`;
    if (state === 'ready') return `<button type="button" class="btn btn-primary" data-act="install">${esc(t('about.install'))}</button>`;
    return `<p class="muted about-install-hint">${esc(t(state === 'ios' ? 'about.installIos' : 'about.installHint'))}</p>`;
  }

  paint() {
    if (!this.active) return;
    const m = this.metrics;
    const words = m ? m.classes - 1 : 55;
    const people = m ? m.signersTrain + m.signersTest : '—';
    const stats = [
      [String(words), t('about.stat.words')],
      [m ? String(m.samples) : '—', t('about.stat.samples')],
      [String(people), t('about.stat.people')],
      [pct(this.seq?.testAccuracy ?? m?.testAccuracy), t('about.stat.accuracy')],
      [pct(this.seq?.words?.acceptedWrong), t('about.stat.wrong')],
    ];
    this.root.innerHTML = `
      <section class="about-hero">
        <div class="about-hero-text">
          <h1>${esc(t('about.title'))}</h1>
          <p class="about-lead">${esc(t('about.lead'))}</p>
          <div class="about-install">${this.installHtml()}</div>
        </div>
        <figure class="about-qr">
          <img src="${import.meta.env.BASE_URL}qr.svg" width="180" height="180" alt="${esc(t('about.qrAlt'))}" />
          <figcaption>${esc(t('about.qr'))}<b>dastiguyo.king.tj</b></figcaption>
        </figure>
      </section>

      <section class="about-card about-problem">
        <h2>${esc(t('about.problemTitle'))}</h2>
        <p>${esc(t('about.problem'))}</p>
        <h2>${esc(t('about.solutionTitle'))}</h2>
        <p>${esc(t('about.solution'))}</p>
      </section>

      <section>
        <h2>${esc(t('about.featuresTitle'))}</h2>
        <div class="about-features">
          ${FEATURES.map(([href, title, text]) => `<a class="about-feature" href="${href}"><b>${esc(t(title))}</b><span>${esc(t(text))}</span></a>`).join('')}
        </div>
      </section>

      <section>
        <h2>${esc(t('about.howTitle'))}</h2>
        <ol class="about-steps">${STEPS.map((k) => `<li>${esc(t(k))}</li>`).join('')}</ol>
      </section>

      <section>
        <h2>${esc(t('about.numbersTitle'))}</h2>
        <div class="about-stats">${stats.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
        <p class="hint">${esc(t('about.numbersNote'))}</p>
      </section>

      <section class="about-card">
        <h2>${esc(t('about.honestTitle'))}</h2>
        <p>${esc(t('about.honest'))}</p>
        <h2>${esc(t('about.nextTitle'))}</h2>
        <ul class="about-next">
          <li>${esc(t('about.next1'))}</li>
          <li>${esc(t('about.next2'))}</li>
          <li>${esc(t('about.next3'))}</li>
          <li>${esc(t('about.next4'))}</li>
        </ul>
      </section>

      <section>
        <h2>${esc(t('about.techTitle'))}</h2>
        <p class="about-tech">${esc(t('about.tech'))}</p>
      </section>`;
  }
}
