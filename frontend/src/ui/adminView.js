// Страница «Идоракунӣ»: вход, статистика, словарь жестов, проверка примеров волонтёров,
// фразы, обучение и публикация модели на сервере, пользователи.
// Волонтёр (contributor) видит только свои примеры; всё остальное — администратор.

import { getLang, onLangChange, t } from '../i18n/i18n.js';
import { ApiError, api, getUser, isAdmin, login, logout, onAuthChange } from '../api/api.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (v) => `${Math.round(v * 1000) / 10}%`;
const date = (iso) => new Date(iso).toLocaleDateString(getLang() === 'ru' ? 'ru-RU' : 'tg-TJ');

const ADMIN_TABS = ['stats', 'gestures', 'samples', 'phrases', 'models', 'users'];

export class AdminView {
  constructor() {
    this.root = $('adminRoot');
    this.tab = 'stats';
    this.sampleFilter = 'pending';
    this.message = null; // {text, kind}
    this.pollTimer = 0;
    this.active = false;

    this.root.addEventListener('submit', (e) => this.onSubmit(e));
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('change', (e) => this.onChange(e));
    onLangChange(() => this.render());
    onAuthChange(() => {
      this.tab = isAdmin() ? 'stats' : 'samples';
      this.render();
    });
  }

  setActive(active) {
    this.active = active;
    if (active) this.render();
    else clearTimeout(this.pollTimer);
  }

  flash(text, kind = 'ok') {
    this.message = { text, kind };
  }

  async run(action) {
    try {
      await action();
    } catch (err) {
      this.flash(err instanceof ApiError ? err.message : String(err), 'error');
    }
    await this.render();
  }

  // ---------- Отрисовка ----------

  async render() {
    if (!this.active) return;
    const user = getUser();
    if (!user) {
      this.root.innerHTML = this.loginHtml();
      return;
    }
    const tabs = isAdmin() ? ADMIN_TABS : ['samples'];
    if (!tabs.includes(this.tab)) this.tab = tabs[0];
    let body = '';
    try {
      body = await this[`${this.tab}Html`]();
    } catch (err) {
      body = `<p class="note is-error">${esc(err instanceof ApiError ? err.message : err)}</p>`;
    }
    const msg = this.message;
    this.message = null;
    this.root.innerHTML = `
      <div class="admin-head">
        <h1>${esc(t('ad.title'))}</h1>
        <span class="muted">${esc(t('ad.hello', { username: user.username, role: t(`ad.role.${user.role}`) }))}</span>
        <button type="button" class="btn btn-secondary btn-small" data-act="logout">${esc(t('ad.logout'))}</button>
      </div>
      <nav class="admin-tabs">${tabs
        .map((tab) => `<button type="button" data-tab="${tab}" ${tab === this.tab ? 'aria-current="page"' : ''}>${esc(t(`ad.tab.${tab}`))}</button>`)
        .join('')}</nav>
      ${msg ? `<p class="note ${msg.kind === 'error' ? 'is-error' : 'is-ok'}">${esc(msg.text)}</p>` : ''}
      <div class="admin-body">${body}</div>`;
  }

  loginHtml() {
    const msg = this.message;
    this.message = null;
    return `
      <form class="admin-login" data-form="login">
        <h1>${esc(t('ad.loginTitle'))}</h1>
        <p class="hint">${esc(t('ad.loginHint'))}</p>
        <label class="field"><span>${esc(t('ad.username'))}</span><input name="username" autocomplete="username" required /></label>
        <label class="field"><span>${esc(t('ad.password'))}</span><input name="password" type="password" autocomplete="current-password" required /></label>
        <button type="submit" class="btn btn-primary btn-lg">${esc(t('ad.login'))}</button>
        ${msg ? `<p class="note is-error">${esc(msg.text)}</p>` : ''}
      </form>`;
  }

  async statsHtml() {
    const s = await api('/stats');
    const users = Object.entries(s.users)
      .map(([role, n]) => `${t(`ad.role.${role}`)}: ${n}`)
      .join(', ');
    const tile = (label, value) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
    return `
      <div class="stats">
        ${tile(t('ad.st.gestures'), s.gestures)}
        ${tile(t('ad.st.approved'), s.samples_approved)}
        ${tile(t('ad.st.pending'), s.samples_pending)}
        ${tile(t('ad.st.audio'), s.audio_clips)}
        ${tile(t('ad.st.model'), s.published_version ? `v${s.published_version}, ${pct(s.published_accuracy)}` : t('ad.st.noModel'))}
      </div>
      <p class="muted">${esc(t('ad.st.users'))}: ${esc(users)}</p>
      <h2>${esc(t('ad.st.perGesture'))}</h2>
      ${this.table(
        [t('ad.s.gesture'), t('ad.g.category'), t('ad.st.approved'), t('ad.st.pending')],
        s.per_gesture.map((g) => [esc(g.name_tj), esc(t(`ad.g.cat.${g.category}`)), g.approved, g.pending]),
      )}`;
  }

  async gesturesHtml() {
    const list = await api('/gestures?include_inactive=true');
    return `
      <form class="admin-form" data-form="gesture">
        <input name="name_tj" required placeholder="${esc(t('ad.g.nameTj'))}" />
        <input name="name_ru" placeholder="${esc(t('ad.g.nameRu'))}" />
        <select name="category">
          ${['word', 'letter', 'system'].map((c) => `<option value="${c}">${esc(t(`ad.g.cat.${c}`))}</option>`).join('')}
        </select>
        <button type="submit" class="btn btn-primary">${esc(t('ad.add'))}</button>
      </form>
      ${this.table(
        [t('ad.g.nameTj'), t('ad.g.nameRu'), t('ad.g.category'), t('ad.g.active'), ''],
        list.map((g) => [
          esc(g.name_tj),
          esc(g.name_ru),
          esc(t(`ad.g.cat.${g.category}`)),
          `<input type="checkbox" data-act="toggle-gesture" data-id="${g.id}" ${g.is_active ? 'checked' : ''} />`,
          `<button type="button" class="btn btn-small btn-danger" data-act="delete" data-path="/gestures/${g.id}">${esc(t('ad.delete'))}</button>`,
        ]),
      )}`;
  }

  async samplesHtml() {
    const gestures = await api('/gestures?include_inactive=true');
    const names = new Map(gestures.map((g) => [g.id, g.name_tj]));
    const filter = this.sampleFilter === 'pending' ? '?approved=false&limit=200' : '?limit=200';
    const list = await api(`/samples${filter}`);
    const admin = isAdmin();
    const pending = list.filter((s) => !s.is_approved);
    return `
      ${admin ? '' : `<p class="hint">${esc(t('ad.s.contribHint'))}</p>`}
      <div class="admin-form">
        <select data-act="sample-filter">
          <option value="pending" ${this.sampleFilter === 'pending' ? 'selected' : ''}>${esc(t('ad.s.pending'))}</option>
          <option value="all" ${this.sampleFilter === 'all' ? 'selected' : ''}>${esc(t('ad.s.all'))}</option>
        </select>
        ${admin && pending.length ? `<button type="button" class="btn btn-primary" data-act="approve-all">${esc(t('ad.s.approveAll'))} (${pending.length})</button>` : ''}
      </div>
      ${this.table(
        ['#', t('ad.s.gesture'), t('ad.s.frames'), t('ad.s.hands'), t('ad.s.date'), ''],
        list.map((s) => [
          s.id,
          esc(names.get(s.gesture_id) ?? s.gesture_id),
          s.frame_count,
          s.hand_count,
          date(s.created_at),
          admin
            ? `<button type="button" class="btn btn-small ${s.is_approved ? 'btn-secondary' : 'btn-primary'}" data-act="approve" data-id="${s.id}" data-value="${!s.is_approved}">${esc(t(s.is_approved ? 'ad.s.unapprove' : 'ad.s.approve'))}</button>
               <button type="button" class="btn btn-small btn-danger" data-act="delete" data-path="/samples/${s.id}">${esc(t('ad.delete'))}</button>`
            : esc(s.is_approved ? t('ad.s.approved') : t('ad.s.pending')),
        ]),
      )}`;
  }

  async phrasesHtml() {
    const [rules, quick] = await Promise.all([api('/phrases'), api('/quick-phrases')]);
    return `
      <h2>${esc(t('ad.p.rules'))}</h2>
      <form class="admin-form" data-form="phrase">
        <input name="words" required placeholder="${esc(t('ad.p.words'))}" />
        <input name="text_tj" required placeholder="${esc(t('ad.p.textTj'))}" />
        <input name="text_ru" placeholder="${esc(t('ad.p.textRu'))}" />
        <button type="submit" class="btn btn-primary">${esc(t('ad.add'))}</button>
      </form>
      ${this.table(
        [t('ad.p.words'), t('ad.p.textTj'), t('ad.p.textRu'), ''],
        rules.map((p) => [esc(p.words.join(' + ')), esc(p.text_tj), esc(p.text_ru), this.deleteBtn(`/phrases/${p.id}`)]),
      )}
      <h2>${esc(t('ad.p.quick'))}</h2>
      <form class="admin-form" data-form="quick">
        <input name="text_tj" required placeholder="${esc(t('ad.p.textTj'))}" />
        <input name="text_ru" placeholder="${esc(t('ad.p.textRu'))}" />
        <input name="order" type="number" value="${quick.length}" aria-label="${esc(t('ad.p.order'))}" />
        <button type="submit" class="btn btn-primary">${esc(t('ad.add'))}</button>
      </form>
      ${this.table(
        [t('ad.p.order'), t('ad.p.textTj'), t('ad.p.textRu'), ''],
        quick.map((q) => [q.order, esc(q.text_tj), esc(q.text_ru), this.deleteBtn(`/quick-phrases/${q.id}`)]),
      )}`;
  }

  async modelsHtml() {
    const [status, versions] = await Promise.all([api('/models/train/status'), api('/models')]);
    const statusText = {
      idle: '',
      running: t('ad.m.running', { message: status.message }),
      done: t('ad.m.done', { acc: status.accuracy != null ? pct(status.accuracy) : '—' }),
      failed: t('ad.m.failed', { message: status.message }),
    }[status.state];
    // Пока идёт обучение — обновляем страницу каждые 2 секунды
    clearTimeout(this.pollTimer);
    if (status.state === 'running') this.pollTimer = setTimeout(() => this.render(), 2000);
    return `
      <p class="hint">${esc(t('ad.m.trainHint'))}</p>
      <div class="admin-form">
        <label class="check"><input type="checkbox" id="adAutoPublish" /> <span>${esc(t('ad.m.autoPublish'))}</span></label>
        <button type="button" class="btn btn-primary" data-act="train" ${status.state === 'running' ? 'disabled' : ''}>${esc(t('ad.m.train'))}</button>
      </div>
      ${status.state === 'running' ? `<div class="progress"><div class="progress-bar" style="width:${status.progress * 100}%"></div></div>` : ''}
      ${statusText ? `<p class="note ${status.state === 'failed' ? 'is-error' : status.state === 'done' ? 'is-ok' : ''}">${esc(statusText)}</p>` : ''}
      <h2>${esc(t('ad.m.versions'))}</h2>
      ${this.table(
        [t('ad.m.version'), t('ad.m.accuracy'), t('ad.st.gestures'), t('ad.s.date'), ''],
        versions.map((m) => [
          `v${m.version}`,
          pct(m.accuracy),
          m.gesture_list.length,
          date(m.created_at),
          m.is_published
            ? `<b>${esc(t('ad.m.published'))}</b>`
            : `<button type="button" class="btn btn-small btn-primary" data-act="publish" data-id="${m.id}">${esc(t('ad.m.publish'))}</button>`,
        ]),
      )}`;
  }

  async usersHtml() {
    const users = await api('/users');
    return `
      <form class="admin-form" data-form="user">
        <input name="username" required minlength="3" placeholder="${esc(t('ad.username'))}" />
        <input name="password" type="password" required minlength="8" placeholder="${esc(t('ad.password'))}" />
        <select name="role">
          <option value="contributor">${esc(t('ad.role.contributor'))}</option>
          <option value="admin">${esc(t('ad.role.admin'))}</option>
        </select>
        <button type="submit" class="btn btn-primary">${esc(t('ad.add'))}</button>
      </form>
      ${this.table(
        [t('ad.username'), t('ad.u.role'), t('ad.u.created'), ''],
        users.map((u) => [esc(u.username), esc(t(`ad.role.${u.role}`)), date(u.created_at), u.id === getUser()?.id ? '' : this.deleteBtn(`/users/${u.id}`)]),
      )}`;
  }

  table(head, rows) {
    if (!rows.length) return `<p class="muted">${esc(t('ad.empty'))}</p>`;
    return `<div class="table-wrap"><table>
      <thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  }

  deleteBtn(path) {
    return `<button type="button" class="btn btn-small btn-danger" data-act="delete" data-path="${path}">${esc(t('ad.delete'))}</button>`;
  }

  // ---------- Действия ----------

  onSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form));
    const kind = form.dataset.form;
    if (kind === 'login') {
      this.run(async () => {
        await login(data.username.trim(), data.password);
      });
      return;
    }
    const requests = {
      gesture: () => api('/gestures', { method: 'POST', body: { name_tj: data.name_tj.trim(), name_ru: data.name_ru.trim(), category: data.category } }),
      phrase: () =>
        api('/phrases', {
          method: 'POST',
          body: { words: data.words.split(',').map((w) => w.trim()).filter(Boolean), text_tj: data.text_tj.trim(), text_ru: data.text_ru.trim() },
        }),
      quick: () => api('/quick-phrases', { method: 'POST', body: { text_tj: data.text_tj.trim(), text_ru: data.text_ru.trim(), order: Number(data.order) || 0 } }),
      user: () => api('/users', { method: 'POST', body: { username: data.username.trim(), password: data.password, role: data.role } }),
    };
    this.run(async () => {
      await requests[kind]();
      this.flash(t('ad.saved'));
    });
  }

  onClick(e) {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      this.tab = tab.dataset.tab;
      this.render();
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const { act, id, path } = btn.dataset;
    if (act === 'logout') logout();
    if (act === 'delete' && confirm(t('ad.confirmDelete'))) this.run(() => api(path, { method: 'DELETE' }));
    if (act === 'approve') {
      this.run(() => api(`/samples/${id}/approve`, { method: 'PATCH', body: { is_approved: btn.dataset.value === 'true' } }));
    }
    if (act === 'approve-all') {
      this.run(async () => {
        const pending = await api('/samples?approved=false&limit=500');
        for (const s of pending) await api(`/samples/${s.id}/approve`, { method: 'PATCH', body: { is_approved: true } });
        this.flash(t('ad.saved'));
      });
    }
    if (act === 'train') {
      this.run(() => api('/models/train', { method: 'POST', body: { auto_publish: $('adAutoPublish').checked } }));
    }
    if (act === 'publish') this.publish(id);
  }

  onChange(e) {
    const el = e.target;
    if (el.dataset.act === 'toggle-gesture') {
      this.run(() => api(`/gestures/${el.dataset.id}`, { method: 'PATCH', body: { is_active: el.checked } }));
    }
    if (el.dataset.act === 'sample-filter') {
      this.sampleFilter = el.value;
      this.render();
    }
  }

  /** Публикация: если новая модель хуже текущей — спросить и опубликовать принудительно. */
  publish(id) {
    this.run(async () => {
      try {
        await api(`/models/${id}/publish`, { method: 'POST' });
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'model_worse') throw err;
        if (!confirm(t('ad.m.forceConfirm', { message: err.message }))) return;
        await api(`/models/${id}/publish?force=true`, { method: 'POST' });
      }
      this.flash(t('ad.saved'));
    });
  }
}
