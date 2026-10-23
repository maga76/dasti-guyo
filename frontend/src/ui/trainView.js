// Экран «Омӯзиш» — пошаговый мастер:
//   1. включить камеру → 2. записать жесты → 3. записать «нет жеста» → 4. обучить → 5. проверить.
// Текущий шаг раскрыт и подсвечен, пройденные отмечены галочкой.

import { onLangChange, t } from '../i18n/i18n.js';
import { drawPoseThumb } from '../hands/drawing.js';
import { RecordError } from '../dataset/recorder.js';
import {
  MIN_SAMPLES,
  NONE_LABEL,
  RECOMMENDED_SAMPLES,
  addSample,
  buildBackup,
  deleteLabel,
  deleteSample,
  downloadJson,
  findWarnings,
  getAllSamples,
  getDatasetChangedAt,
  groupByLabel,
  importBackup,
} from '../dataset/dataset.js';
import { TrainError } from '../model/classifier.js';
import { lineChart } from './charts.js';
import { syncSamples } from '../api/sync.js';
import { onAuthChange } from '../api/api.js';

const $ = (id) => document.getElementById(id);

// Сколько кадров в одной записи (~1.7 с при 30 кадрах в секунду — как жесты в наборе Slovo)
const FRAMES_PER_SAMPLE = 50;
const STEP_ORDER = ['camera', 'gestures', 'none', 'train', 'test'];

/** Название жеста для показа (служебный класс переводим). */
export function labelName(label) {
  return label === NONE_LABEL ? t('train.noneLabel') : label;
}

/** Статус хранится как ключ + параметры, чтобы перерисовать его при смене языка. */
function setNote(el, key, params = {}, kind = '') {
  el._note = key ? { key, params, kind } : null;
  renderNote(el);
}

function renderNote(el) {
  const note = el._note;
  el.textContent = note ? t(note.key, note.params) : '';
  el.classList.toggle('is-ok', note?.kind === 'ok');
  el.classList.toggle('is-error', note?.kind === 'error');
}

const percent = (value) => `${Math.round(value * 100)}%`;

export class TrainView {
  /**
   * @param {object} deps
   * @param {import('../dataset/recorder.js').Recorder} deps.recorder
   * @param {import('../model/classifier.js').GestureClassifier} deps.classifier
   * @param {() => boolean} deps.isCameraOn
   * @param {() => void} deps.startCamera
   * @param {import('../recognizer/recognizer.js').LiveRecognizer} deps.recognizer
   * @param {() => void} [deps.onModelChange] модель обучена или загружена
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.active = false;
    this.training = false;
    this.outdated = false;
    this.groups = [];
    this.openLabels = new Set(); // раскрытые жесты в списке
    this.openSteps = new Set();
    this.currentStep = null;

    this.bindEvents();
    this.recognizer.onPrediction((p) => this.onPrediction(p));
    onLangChange(() => {
      document.querySelectorAll('.note').forEach(renderNote);
      this.renderLists();
      this.renderSteps();
      this.renderTrainInfo();
    });
  }

  async init() {
    await this.classifier.load();
    await this.refresh();
    this.onModelChange?.();
    // Записи, накопленные без интернета, уходят на сервер при первой возможности
    this.sync();
    window.addEventListener('online', () => this.sync());
    onAuthChange(() => this.sync());
  }

  /** Отправить на сервер записи, которые ещё не отправлены. */
  async sync() {
    const r = await syncSamples();
    const parts = [];
    if (!r.loggedIn) parts.push(t('sync.login', { n: r.waiting }));
    else if (r.error) parts.push(t('sync.error', { detail: r.error }));
    else parts.push(t('sync.done', { sent: r.sent, waiting: r.waiting }));
    if (r.missing.length) parts.push(t('sync.missing', { list: r.missing.map(labelName).join(', ') }));
    $('syncStatus').textContent = parts.join(' ');
  }

  setActive(active) {
    this.active = active;
  }

  /** Камера включилась или выключилась — пересчитываем шаги. */
  onCameraChange() {
    this.renderSteps();
  }

  bindEvents() {
    $('btnStepCamera').addEventListener('click', () => this.startCamera());
    $('btnRecord').addEventListener('click', () => this.record(false));
    $('btnRecordNone').addEventListener('click', () => this.record(true));
    $('gestureName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.record(false);
    });
    $('btnTrain').addEventListener('click', () => this.train());
    $('btnResetModel').addEventListener('click', () => this.resetModel());
    $('btnSync').addEventListener('click', () => this.sync());
    $('btnExport').addEventListener('click', () => this.exportAll());
    $('fileImport').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = ''; // чтобы тот же файл можно было выбрать снова
      if (file) this.importAll(file);
    });

    // Заголовок шага раскрывает и сворачивает его
    $('steps').addEventListener('click', (e) => {
      const head = e.target.closest('.step-head');
      if (!head) return;
      const step = head.parentElement.dataset.step;
      if (this.openSteps.has(step)) this.openSteps.delete(step);
      else this.openSteps.add(step);
      this.renderSteps();
    });

    for (const list of [$('gestureList'), $('noneList')]) {
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const { act, label, id } = btn.dataset;
        if (act === 'delete-sample') this.removeSample(Number(id));
        if (act === 'delete-label') this.removeLabel(label);
        if (act === 'more') {
          $('gestureName').value = label;
          this.record(false);
        }
      });
      list.addEventListener(
        'toggle',
        (e) => {
          const label = e.target.dataset?.label;
          if (label == null) return;
          if (e.target.open) {
            this.openLabels.add(label);
            this.drawThumbs(e.target);
          } else this.openLabels.delete(label);
        },
        true,
      );
    }
  }

  // ---------- Шаги ----------

  stepDone() {
    const words = this.groups.filter((g) => g.label !== NONE_LABEL);
    const none = this.groups.find((g) => g.label === NONE_LABEL);
    return {
      camera: this.isCameraOn(),
      gestures: words.some((g) => g.samples.length >= MIN_SAMPLES),
      none: (none?.samples.length ?? 0) >= MIN_SAMPLES,
      train: this.classifier.meta?.source === 'local' && !this.outdated,
    };
  }

  renderSteps() {
    const done = this.stepDone();
    const current = STEP_ORDER.find((s) => !done[s]) ?? 'test';
    // Когда переходим к новому шагу — раскрываем его
    if (current !== this.currentStep) {
      this.currentStep = current;
      this.openSteps = new Set([current]);
    }

    document.querySelectorAll('.step').forEach((el) => {
      const step = el.dataset.step;
      el.dataset.state = done[step] ? 'done' : step === current ? 'current' : 'todo';
      el.classList.toggle('is-open', this.openSteps.has(step));
      el.querySelector('.step-head').setAttribute('aria-expanded', String(this.openSteps.has(step)));
    });

    const words = this.groups.filter((g) => g.label !== NONE_LABEL);
    const none = this.groups.find((g) => g.label === NONE_LABEL);
    const meta = this.classifier.meta;
    $('sumCamera').textContent = done.camera ? t('step.camera.done') : '';
    $('sumGestures').textContent = words.length ? t('step.gestures.summary', { n: words.length }) : '';
    $('sumNone').textContent = none ? t('train.samples', { n: none.samples.length }) : '';
    $('sumTrain').textContent = meta?.source !== 'local'
      ? ''
      : this.outdated
        ? t('step.train.outdated')
        : t('step.train.summary', { acc: percent(meta.accuracy) });
    $('btnStepCamera').hidden = done.camera;
  }

  // ---------- Запись ----------

  async record(isNone) {
    // Повторное нажатие во время записи — отмена
    if (this.recorder.isBusy) {
      this.recorder.cancel();
      return;
    }
    if (this.training) return;

    const status = isNone ? $('noneStatus') : $('recStatus');
    const button = isNone ? $('btnRecordNone') : $('btnRecord');
    if (!this.isCameraOn()) {
      setNote(status, 'train.cameraOff', {}, 'error');
      return;
    }
    const label = isNone ? NONE_LABEL : $('gestureName').value.trim();
    if (!label) {
      setNote(status, 'train.nameRequired', {}, 'error');
      $('gestureName').focus();
      return;
    }

    const stage = $('stage');
    const countdown = $('countdown');
    const caption = $('countdownLabel');
    this.setRecording(button, true);
    setNote(status, null);
    countdown.hidden = false;
    caption.textContent = labelName(label);
    stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const result = await this.recorder.record({
        target: FRAMES_PER_SAMPLE,
        isNone,
        onCountdown: (n) => {
          $('countdownNumber').textContent = n || '';
          stage.classList.toggle('recording', n === 0);
        },
        onProgress: (n, total) => {
          caption.textContent = `${labelName(label)} — ${t('train.recording', { n, total })}`;
        },
      });
      await addSample({ label, ...result });
      if (!isNone) this.openLabels.add(label);
      setNote(status, 'train.saved', { label: labelName(label), frames: result.frames.length }, 'ok');
      await this.refresh();
      this.sync(); // если вошли и есть сеть — сразу на сервер
    } catch (err) {
      if (err instanceof RecordError && err.code === 'cancelled') setNote(status, 'train.cancelled');
      else if (err instanceof RecordError) setNote(status, 'train.noHands', {}, 'error');
      else {
        console.error(err);
        setNote(status, 'train.trainFailed', { detail: err.message }, 'error');
      }
    } finally {
      countdown.hidden = true;
      stage.classList.remove('recording');
      this.setRecording(button, false);
    }
  }

  /** Во время записи кнопка превращается в «Отмена», остальные недоступны. */
  setRecording(button, recording) {
    button.classList.toggle('is-recording', recording);
    button.querySelector('[data-i18n]').dataset.i18n = recording
      ? 'train.cancel'
      : button.id === 'btnRecordNone'
        ? 'train.recordNone'
        : 'train.record';
    button.querySelector('[data-i18n]').textContent = t(button.querySelector('[data-i18n]').dataset.i18n);
    for (const id of ['btnRecord', 'btnRecordNone', 'btnTrain']) {
      if ($(id) !== button) $(id).disabled = recording;
    }
  }

  // ---------- Списки записанного ----------

  async refresh() {
    this.groups = groupByLabel(await getAllSamples());
    const meta = this.classifier.meta;
    const changedAt = await getDatasetChangedAt();
    this.outdated = Boolean(meta?.source === 'local' && changedAt && changedAt > meta.trainedAt);

    this.renderLists();
    this.renderSteps();
    this.renderTrainInfo();
    $('gestureNames').replaceChildren(
      ...this.groups
        .filter((g) => g.label !== NONE_LABEL)
        .map((g) => Object.assign(document.createElement('option'), { value: g.label })),
    );
  }

  renderLists() {
    const words = this.groups.filter((g) => g.label !== NONE_LABEL);
    const none = this.groups.filter((g) => g.label === NONE_LABEL);
    $('gestureList').innerHTML = words.map((g) => this.groupHtml(g, true)).join('');
    $('noneList').innerHTML = none.map((g) => this.groupHtml(g, false)).join('');
    document.querySelectorAll('.gesture[open]').forEach((d) => this.drawThumbs(d));
  }

  groupHtml(g, canRecordMore) {
    const n = g.samples.length;
    const label = escapeHtml(g.label);
    const fill = Math.min(1, n / RECOMMENDED_SAMPLES);
    const thumbs = g.samples
      .map(
        (s) => `<figure class="thumb">
          <canvas width="64" height="64" data-sample="${s.id}"></canvas>
          <button type="button" class="thumb-del" data-act="delete-sample" data-id="${s.id}"
            title="${escapeHtml(t('train.deleteSample'))}" aria-label="${escapeHtml(t('train.deleteSample'))}">×</button>
        </figure>`,
      )
      .join('');
    return `<details class="gesture" data-label="${label}" ${this.openLabels.has(g.label) ? 'open' : ''}>
      <summary>
        <span class="gesture-name">${escapeHtml(labelName(g.label))}</span>
        <span class="gesture-count">${escapeHtml(t('train.countOf', { n, rec: RECOMMENDED_SAMPLES }))}</span>
        <span class="gesture-bar ${fill === 1 ? 'is-full' : ''}"><span style="width:${fill * 100}%"></span></span>
      </summary>
      <div class="gesture-body">
        <div class="thumbs">${thumbs}</div>
        <div class="btn-row">
          ${canRecordMore ? `<button type="button" class="btn btn-small btn-secondary" data-act="more" data-label="${label}">${escapeHtml(t('train.addMore'))}</button>` : ''}
          <button type="button" class="btn btn-small btn-danger" data-act="delete-label" data-label="${label}">${escapeHtml(t('train.deleteGesture'))}</button>
        </div>
      </div>
    </details>`;
  }

  /** Миниатюры рисуем только у раскрытых жестов — их может быть много. */
  drawThumbs(details) {
    const group = this.groups.find((g) => g.label === details.dataset.label);
    if (!group) return;
    const byId = new Map(group.samples.map((s) => [s.id, s]));
    details.querySelectorAll('canvas[data-sample]').forEach((canvas) => {
      const sample = byId.get(Number(canvas.dataset.sample));
      if (sample) drawPoseThumb(canvas, sample.frames[Math.floor(sample.frames.length / 2)]);
    });
  }

  async removeSample(id) {
    await deleteSample(id);
    await this.refresh();
  }

  async removeLabel(label) {
    if (!confirm(t('train.confirmDeleteGesture', { label: labelName(label) }))) return;
    await deleteLabel(label);
    this.openLabels.delete(label);
    await this.refresh();
  }

  // ---------- Обучение ----------

  async train() {
    if (this.training || this.recorder.isBusy) return;
    const status = $('trainStatus');
    const bar = $('trainProgress');
    this.training = true;
    $('btnTrain').disabled = true;
    bar.hidden = false;
    bar.firstElementChild.style.width = '0%';

    try {
      const curve = [];
      const meta = await this.classifier.train(this.groups, {
        useBase: $('chkUseBase').checked,
        onEpoch: ({ epoch, epochs, train, test }) => {
          bar.firstElementChild.style.width = `${(epoch / epochs) * 100}%`;
          setNote(status, 'train.training', { epoch, epochs });
          // График рисуется прямо во время обучения
          curve.push({ epoch, train, test });
          this.drawCurve(curve);
        },
      });
      setNote(status, 'train.trained', { acc: percent(meta.accuracy) }, 'ok');
      this.onModelChange?.();
    } catch (err) {
      if (err instanceof TrainError && err.code === 'needTwo') setNote(status, 'train.needTwo', {}, 'error');
      else if (err instanceof TrainError) setNote(status, 'train.needSamples', { min: MIN_SAMPLES }, 'error');
      else {
        console.error(err);
        setNote(status, 'train.trainFailed', { detail: err.message }, 'error');
      }
    } finally {
      this.training = false;
      $('btnTrain').disabled = false;
      bar.hidden = true;
      await this.refresh();
    }
  }

  drawCurve(curve) {
    lineChart($('trainChart'), curve, {
      train: t('train.chartTrain'),
      test: t('train.chartTest'),
      epoch: t('train.chartEpoch'),
    });
  }

  /** Удалить свою модель и вернуться к базовой (записи остаются). */
  async resetModel() {
    if (!confirm(t('train.resetConfirm'))) return;
    await this.classifier.clear();
    await this.classifier.load();
    setNote($('trainStatus'), null);
    $('trainChart').replaceChildren();
    this.onModelChange?.();
    await this.refresh();
  }

  renderTrainInfo() {
    const meta = this.classifier.meta;
    const local = meta?.source === 'local';
    $('accNote').textContent = local ? t(meta.validated ? 'train.accNote' : 'train.accTrainOnly') : '';
    $('btnResetModel').disabled = !local;
    if (local && meta.curve?.length && !this.training) this.drawCurve(meta.curve);

    // Предупреждения: качество данных и путаница модели
    const items = findWarnings(this.groups).map((w) => {
      if (w.type === 'noNone') return t('warn.noNone');
      if (w.type === 'few') return t('warn.few', { label: labelName(w.label), n: w.n, rec: RECOMMENDED_SAMPLES });
      return t('warn.similar', { a: labelName(w.a), b: labelName(w.b) });
    });
    if (this.outdated) items.unshift(t('train.outdated'));
    else if (local) {
      for (const p of this.classifier.confusedPairs()) {
        items.push(t('warn.confused', { a: labelName(p.a), b: labelName(p.b), pct: percent(p.share) }));
      }
    }
    $('warnings').replaceChildren(
      ...items.map((text) => Object.assign(document.createElement('li'), { textContent: text })),
    );
    if (!meta) {
      $('liveLabel').textContent = t('train.noModel');
      $('liveConf').textContent = '';
    }
  }

  // ---------- Проверка в реальном времени ----------

  /** Ответ распознавателя (~7 раз в секунду): что модель видит прямо сейчас. */
  onPrediction({ label, confidence, hands }) {
    if (!this.active || this.training) return;
    if (!hands) {
      $('liveLabel').textContent = t('train.liveNoHands');
      $('liveConf').textContent = '';
      $('liveBar').style.width = '0%';
      return;
    }
    $('liveLabel').textContent = labelName(label);
    $('liveConf').textContent = percent(confidence);
    $('liveBar').style.width = percent(confidence);
  }

  // ---------- Файл ----------

  async exportAll() {
    const backup = await buildBackup(await this.classifier.exportModel());
    const stamp = new Date().toISOString().slice(0, 10);
    downloadJson(backup, `dasti-guyo-${stamp}.json`);
  }

  async importAll(file) {
    const status = $('fileStatus');
    try {
      const { added, model } = await importBackup(file);
      if (model) await this.classifier.importModel(model);
      setNote(status, model ? 'file.importedWithModel' : 'file.imported', { samples: added }, 'ok');
      await this.refresh();
      if (model) this.onModelChange?.();
    } catch (err) {
      console.error(err);
      setNote(status, 'file.badFile', {}, 'error');
    }
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
