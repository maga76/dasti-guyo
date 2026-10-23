// Небольшие графики на SVG без библиотек: кривая обучения и точность по жестам.
// Цвета — CSS-переменные --series-1 / --series-2 (проверены на различимость
// при дальтонизме в светлой и тёмной теме). Текст — цветами текста, не цветом серии.

const SVG = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

const pct = (v) => `${Math.round(v * 100)}%`;

/** Общая всплывающая подсказка. */
function tooltip(container) {
  let tip = container.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    container.append(tip);
  }
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.hidden = false;
      const box = container.getBoundingClientRect();
      const left = Math.min(Math.max(x + 12, 0), box.width - tip.offsetWidth);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`;
    },
    hide() {
      tip.hidden = true;
    },
  };
}

/**
 * Линейный график точности по эпохам.
 * @param {HTMLElement} container
 * @param {{epoch: number, train: number, test?: number}[]} points
 * @param {{train: string, test: string, epoch: string}} names подписи серий и оси
 */
export function lineChart(container, points, names) {
  container.classList.add('chart');
  container.replaceChildren();
  if (!points?.length) return;

  const series = [
    { key: 'train', name: names.train, color: 'var(--series-1)' },
    { key: 'test', name: names.test, color: 'var(--series-2)' },
  ].filter((s) => points.some((p) => p[s.key] != null));

  // Легенда над графиком
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  for (const s of series) {
    const item = document.createElement('span');
    item.innerHTML = `<i style="background:${s.color}"></i>${s.name}`;
    legend.append(item);
  }
  container.append(legend);

  const W = 560;
  const H = 220;
  const m = { top: 12, right: 56, bottom: 28, left: 40 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const maxEpoch = points.at(-1).epoch;
  const x = (e) => m.left + ((e - 1) / Math.max(1, maxEpoch - 1)) * iw;
  const y = (v) => m.top + (1 - v) * ih;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', class: 'chart-svg' }, container);
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    el('line', { x1: m.left, x2: m.left + iw, y1: y(v), y2: y(v), class: 'chart-grid' }, svg);
    el('text', { x: m.left - 8, y: y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' }, svg).textContent = pct(v);
  }
  for (const e of [1, Math.round(maxEpoch / 2), maxEpoch]) {
    el('text', { x: x(e), y: H - 8, class: 'chart-axis', 'text-anchor': 'middle' }, svg).textContent = e;
  }
  el('text', { x: m.left + iw, y: H - 8, class: 'chart-axis', 'text-anchor': 'end', dx: 48 }, svg).textContent = names.epoch;

  for (const s of series) {
    const d = points
      .filter((p) => p[s.key] != null)
      .map((p, i) => `${i ? 'L' : 'M'}${x(p.epoch).toFixed(1)},${y(p[s.key]).toFixed(1)}`)
      .join('');
    el('path', { d, class: 'chart-line', style: `stroke:${s.color}` }, svg);
    // Подпись последнего значения прямо у линии
    const last = points.at(-1)[s.key];
    if (last != null) {
      el('circle', { cx: x(maxEpoch), cy: y(last), r: 4, class: 'chart-dot', style: `fill:${s.color}` }, svg);
      el('text', { x: x(maxEpoch) + 8, y: y(last) + 4, class: 'chart-value' }, svg).textContent = pct(last);
    }
  }

  // Наведение: вертикальная линия и подсказка со значениями на этой эпохе
  const cross = el('line', { y1: m.top, y2: m.top + ih, class: 'chart-cross', visibility: 'hidden' }, svg);
  const hit = el('rect', { x: m.left, y: m.top, width: iw, height: ih, fill: 'transparent' }, svg);
  const tip = tooltip(container);
  const move = (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const epoch = Math.min(maxEpoch, Math.max(1, Math.round(1 + ((px - m.left) / iw) * (maxEpoch - 1))));
    const p = points.find((q) => q.epoch === epoch);
    if (!p) return;
    cross.setAttribute('x1', x(epoch));
    cross.setAttribute('x2', x(epoch));
    cross.setAttribute('visibility', 'visible');
    const rows = series
      .filter((s) => p[s.key] != null)
      .map((s) => `<div><i style="background:${s.color}"></i>${s.name}: <b>${pct(p[s.key])}</b></div>`)
      .join('');
    const cbox = container.getBoundingClientRect();
    tip.show(`<div class="chart-tip-title">${names.epoch} ${epoch}</div>${rows}`, event.clientX - cbox.left, event.clientY - cbox.top);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hide();
  });
}

/**
 * Горизонтальные полосы: точность распознавания каждого жеста.
 * @param {HTMLElement} container
 * @param {{label: string, value: number, detail?: string}[]} items
 */
export function barList(container, items) {
  container.classList.add('chart');
  container.replaceChildren();
  const list = document.createElement('div');
  list.className = 'bars';
  const tip = tooltip(container);
  for (const item of [...items].sort((a, b) => b.value - a.value)) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.tabIndex = 0;
    row.innerHTML = `<span class="bar-label"></span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(item.value * 100, 1)}%"></span></span>
      <span class="bar-value">${pct(item.value)}</span>`;
    row.querySelector('.bar-label').textContent = item.label;
    const show = (event) => {
      const cbox = container.getBoundingClientRect();
      const rbox = row.getBoundingClientRect();
      const px = event?.clientX ?? rbox.left + rbox.width / 2;
      tip.show(`<b></b><div>${item.detail ?? pct(item.value)}</div>`, px - cbox.left, rbox.top - cbox.top);
      container.querySelector('.chart-tip b').textContent = item.label;
    };
    row.addEventListener('pointermove', show);
    row.addEventListener('focus', () => show());
    row.addEventListener('pointerleave', () => tip.hide());
    row.addEventListener('blur', () => tip.hide());
    list.append(row);
  }
  container.append(list);
}
