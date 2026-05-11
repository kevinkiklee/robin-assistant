// Pure SVG chart helpers and components. No dependencies. Components return
// SVG / HTML strings; callers insert into the DOM as needed.

export function scaleLinear({ domain: [d0, d1], range: [r0, r1] }) {
  const dr = d1 - d0 || 1;
  const rr = r1 - r0;
  return (v) => r0 + ((v - d0) / dr) * rr;
}

export function niceTicks(min, max, count = 5) {
  if (max - min <= 0) return [min];
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, i) => min + i * step);
}

export function sparklinePath(values, { width, height }) {
  if (!values || !values.length) return '';
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const x = scaleLinear({ domain: [0, Math.max(values.length - 1, 1)], range: [0, width] });
  const y = scaleLinear({ domain: [min, max || 1], range: [height, 0] });
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(' ');
}

export function barRects(values, { width, height, gap = 2 }) {
  if (!values || !values.length) return [];
  const max = Math.max(...values, 1);
  const w = (width - gap * (values.length - 1)) / values.length;
  return values.map((v, i) => ({
    x: i * (w + gap),
    y: height - (v / max) * height,
    width: Math.max(0, w),
    height: (v / max) * height,
    value: v,
  }));
}

function escapeAttr(s) {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}

export function renderSparkline(values, { width = 80, height = 20, stroke = 'currentColor' } = {}) {
  const d = sparklinePath(values, { width, height });
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
    <path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.2" />
  </svg>`;
}

const AXIS_GAP = 18;
const Y_AXIS_GAP = 36;
const VALUE_LABEL_GAP = 12;

function pickTickIndices(n) {
  if (n <= 6) return Array.from({ length: n }, (_, i) => i);
  const out = new Set([0, n - 1]);
  for (let i = 1; i <= 4; i++) out.add(Math.round(((n - 1) * i) / 5));
  return [...out].sort((a, b) => a - b);
}

function renderSingleValueCallout(label, value, hint = '') {
  return `<div class="chart-single">
    <div class="chart-single-label">${escapeAttr(label)}</div>
    <div class="chart-single-value">${escapeAttr(String(value))}</div>
    ${hint ? `<div class="chart-single-hint">${escapeAttr(hint)}</div>` : ''}
  </div>`;
}

export function renderBarChart(values, labels, { width = 640, height = 180, rolling = null } = {}) {
  if (!values || !values.length) return '';
  if (values.length === 1) {
    return renderSingleValueCallout(labels?.[0] ?? '', values[0], 'only one bucket of data');
  }
  const chartLeft = Y_AXIS_GAP;
  const chartTop = VALUE_LABEL_GAP;
  const chartW = width - chartLeft - 4;
  const chartH = height - chartTop - AXIS_GAP;
  const max = Math.max(...values, 1);
  const gap = Math.min(4, chartW / values.length / 4);
  const bw = (chartW - gap * (values.length - 1)) / values.length;
  const tickIdx = new Set(pickTickIndices(values.length));
  const bars = values
    .map((v, i) => {
      const h = (v / max) * chartH;
      const x = chartLeft + i * (bw + gap);
      const y = chartTop + (chartH - h);
      const lbl = labels?.[i] ?? '';
      const tickLabel = tickIdx.has(i)
        ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(height - 4).toFixed(1)}" text-anchor="middle" class="chart-axis">${escapeAttr(lbl)}</text>`
        : '';
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" data-label="${escapeAttr(lbl)}" data-value="${v}"><title>${escapeAttr(lbl)}: ${v}</title></rect>${tickLabel}`;
    })
    .join('');
  const yAxis = `<text x="${(chartLeft - 4).toFixed(1)}" y="${(chartTop + 4).toFixed(1)}" text-anchor="end" class="chart-axis">${escapeAttr(String(max))}</text>
    <text x="${(chartLeft - 4).toFixed(1)}" y="${(chartTop + chartH).toFixed(1)}" text-anchor="end" class="chart-axis">0</text>`;
  let overlay = '';
  if (rolling && rolling.length === values.length) {
    const points = rolling
      .map((v, i) => {
        const x = chartLeft + i * (bw + gap) + bw / 2;
        const y = chartTop + (chartH - (v / max) * chartH);
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
    overlay = `<path d="${points}" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"></path>`;
  }
  return `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="chart bar">${yAxis}${bars}${overlay}</svg>`;
}

export function renderStackedBarChart(
  buckets,
  series,
  { width = 640, height = 180, palette } = {},
) {
  if (!buckets || !buckets.length) return '';
  const colors = palette ?? [
    '#5b8def',
    '#f59e0b',
    '#10b981',
    '#ef4444',
    '#8b5cf6',
    '#94a3b8',
    '#64748b',
  ];
  const totals = buckets.map((b) => series.reduce((s, k) => s + (b.values[k] || 0), 0));
  if (buckets.length === 1) {
    const b = buckets[0];
    const breakdown = series
      .filter((k) => (b.values[k] || 0) > 0)
      .map((k) => `${k}: ${b.values[k]}`)
      .join(' · ');
    return renderSingleValueCallout(b.bucket, totals[0], breakdown);
  }
  const chartLeft = Y_AXIS_GAP;
  const chartTop = VALUE_LABEL_GAP;
  const chartW = width - chartLeft - 4;
  const chartH = height - chartTop - AXIS_GAP;
  const max = Math.max(...totals, 1);
  const gap = Math.min(4, chartW / buckets.length / 4);
  const bw = (chartW - gap * (buckets.length - 1)) / buckets.length;
  const tickIdx = new Set(pickTickIndices(buckets.length));
  const bars = buckets
    .map((b, i) => {
      let yCursor = chartTop + chartH;
      const x = chartLeft + i * (bw + gap);
      const stack = series
        .map((k, si) => {
          const v = b.values[k] || 0;
          if (v === 0) return '';
          const h = (v / max) * chartH;
          yCursor -= h;
          const color = colors[si % colors.length];
          return `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" data-bucket="${escapeAttr(b.bucket)}" data-series="${escapeAttr(k)}" data-value="${v}"><title>${escapeAttr(b.bucket)} · ${escapeAttr(k)}: ${v}</title></rect>`;
        })
        .join('');
      const tickLabel = tickIdx.has(i)
        ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(height - 4).toFixed(1)}" text-anchor="middle" class="chart-axis">${escapeAttr(b.bucket)}</text>`
        : '';
      return stack + tickLabel;
    })
    .join('');
  const yAxis = `<text x="${(chartLeft - 4).toFixed(1)}" y="${(chartTop + 4).toFixed(1)}" text-anchor="end" class="chart-axis">${escapeAttr(String(max))}</text>
    <text x="${(chartLeft - 4).toFixed(1)}" y="${(chartTop + chartH).toFixed(1)}" text-anchor="end" class="chart-axis">0</text>`;
  const legend = series
    .map((k, si) => {
      const total = buckets.reduce((s, b) => s + (b.values[k] || 0), 0);
      return `<span class="chart-legend-item"><span class="swatch" style="background:${colors[si % colors.length]}"></span>${escapeAttr(k)} <span style="color:#888">(${total})</span></span>`;
    })
    .join(' ');
  return `<div class="chart-legend">${legend}</div>
    <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="chart stacked">${yAxis}${bars}</svg>`;
}

export function renderSmallMultiples(rows, { rowHeight = 24, sparkWidth = 120 } = {}) {
  return rows
    .map(
      (r) => `<div class="sm-row">
    <span class="sm-label">${escapeAttr(r.label)}</span>
    <span class="sm-total">${r.total}</span>
    ${renderSparkline(r.values || [], { width: sparkWidth, height: rowHeight - 6 })}
  </div>`,
    )
    .join('');
}
