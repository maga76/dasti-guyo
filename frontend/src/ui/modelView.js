// Экран «Дар бораи ИИ»: как устроена наша нейросеть и насколько она точна.
// Показывает текущую модель (базовую или обученную пользователем):
// точность на новых людях, график обучения, точность по каждому жесту, данные.

import { getLang, onLangChange, t } from '../i18n/i18n.js';
import { NONE_LABEL } from '../dataset/dataset.js';
import { loadBaseMetrics } from '../dataset/baseDataset.js';
import { barList, lineChart } from './charts.js';
import { labelName } from './trainView.js';

const $ = (id) => document.getElementById(id);
const pct = (v) => `${Math.round(v * 100)}%`;

export class ModelView {
  /** @param {{classifier: import('../model/classifier.js').GestureClassifier}} deps */
  constructor({ classifier }) {
    this.classifier = classifier;
    this.active = false;
    this.baseMetrics = null;
    loadBaseMetrics().then((m) => {
      this.baseMetrics = m;
      this.update();
    });
    onLangChange(() => this.update());
  }

  setActive(active) {
    this.active = active;
    if (active) this.update();
  }

  update() {
    if (!this.active) return;
    const meta = this.classifier.meta;
    if (!meta) {
      $('mAccuracy').textContent = '—';
      $('mAccuracyText').textContent = t('model.noModel');
      return;
    }
    const base = meta.source === 'base';
    const metrics = this.baseMetrics;
    const words = meta.labels.filter((l) => l !== NONE_LABEL).length;

    // Главное число — точность на тех, кого модель не видела
    $('mAccuracy').textContent = pct(meta.accuracy);
    $('mAccuracyText').textContent = base
      ? t('model.hero.base', { signers: metrics?.signersTest ?? '—' })
      : t('model.hero.local');
    const date = meta.trainedAt
      ? new Date(meta.trainedAt).toLocaleDateString(getLang() === 'ru' ? 'ru-RU' : 'tg-TJ')
      : '';
    $('mSource').textContent = t(`model.source.${meta.source}`, { n: words, date, version: meta.version });
    $('mArch').textContent = t('model.p4.arch', { n: meta.labels.length });

    lineChart($('mCurve'), meta.curve ?? [], {
      train: t('train.chartTrain'),
      test: t('train.chartTest'),
      epoch: t('train.chartEpoch'),
    });

    // Точность по каждому жесту: у базовой модели — из отчёта сборки, у своей — из таблицы ошибок
    let perClass = [];
    if (base && metrics) {
      const totals = metrics.testCounts ?? {};
      perClass = metrics.perClass
        .filter((c) => c.accuracy != null && c.label !== NONE_LABEL)
        .map((c) => ({
          label: labelName(c.label),
          value: c.accuracy,
          detail: totals[c.label] ? t('model.perClassDetail', { correct: Math.round(c.accuracy * totals[c.label]), total: totals[c.label] }) : pct(c.accuracy),
        }));
    } else if (meta.confusion) {
      perClass = meta.confusion
        .map((row, i) => {
          const total = row.reduce((s, v) => s + v, 0);
          return total
            ? { label: labelName(meta.labels[i]), value: row[i] / total, detail: t('model.perClassDetail', { correct: row[i], total }) }
            : null;
        })
        .filter(Boolean);
    }
    barList($('mPerClass'), perClass);

    // Данные и путаница
    if (base && metrics) {
      $('mData').textContent = t('model.data.base', {
        samples: metrics.samples,
        signers: metrics.signersTrain + metrics.signersTest,
        train: metrics.signersTrain,
        test: metrics.signersTest,
        source: metrics.source,
      });
    } else if (meta.source === 'local') {
      $('mData').textContent = t(meta.usedBase ? 'model.data.localWithBase' : 'model.data.localOnly', {
        own: meta.sampleCount ?? 0,
      });
    } else {
      $('mData').textContent = t('model.source.server', { version: meta.version, n: words });
    }
    const confused = base ? (metrics?.confused ?? []).filter((c) => c.share >= 0.2) : this.classifier.confusedPairs();
    $('mConfused').replaceChildren(
      ...confused.slice(0, 5).map((c) =>
        Object.assign(document.createElement('li'), {
          textContent: t('warn.confused', { a: labelName(c.a), b: labelName(c.b), pct: pct(c.share) }),
        }),
      ),
    );
  }
}
