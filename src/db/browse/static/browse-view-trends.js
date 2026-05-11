import { escapeHtml } from '/db/static/browse-cards.js';
// Trends page — time-series of activity, growth, and behaviour change (v2).
import {
  renderBarChart,
  renderSmallMultiples,
  renderStackedBarChart,
} from '/db/static/browse-view-charts.js';

const CHARTS = [
  {
    metric: 'activity-pulse',
    title: 'activity pulse',
    subtitle: "Events per bucket. Robin's heartbeat — busy days are tall, quiet days are short.",
    kind: 'bar',
  },
  {
    metric: 'knowledge-growth',
    title: 'knowledge growth',
    subtitle: 'How many entities and knowledge rows are added in each bucket.',
    kind: 'stacked',
  },
  {
    metric: 'event-source-mix',
    title: 'event source mix',
    subtitle: 'Where events come from each bucket — CLI, host, or integrations.',
    kind: 'stacked',
  },
  {
    metric: 'refusals-rate',
    title: 'refusals rate',
    subtitle: 'How often Robin refused an outbound action in each bucket. Lower is usually better.',
    kind: 'bar',
  },
  {
    metric: 'top-entity-engagement',
    title: 'top-entity engagement',
    subtitle: 'The 5 most-mentioned entities, charted across the selected range.',
    kind: 'small-multiples',
  },
];

const RANGES = ['30d', '90d', '1y', 'all'];

export async function activate(host) {
  const u = new URLSearchParams(location.search);
  const range = RANGES.includes(u.get('range')) ? u.get('range') : '90d';

  host.innerHTML = `
    <div class="eyebrow"><span>view</span><span class="sep">·</span><span>trends</span></div>
    <div class="head"><h1>trends</h1></div>
    <div class="purpose">How activity, knowledge, and behavior change over time. Each chart loads independently. When a chart only has one bucket, you'll see a clean numeric callout instead of a one-bar chart.</div>
    <div class="range-ctl" role="radiogroup" aria-label="time range">
      <span class="range-ctl-label">range</span>
      ${RANGES.map((r) => `<button data-range="${r}" aria-checked="${r === range}" data-explain-category="term" data-explain-key="bucket" tabindex="0">${r}</button>`).join('')}
    </div>
    <div class="charts">${CHARTS.map(
      (
        c,
        i,
      ) => `<article class="trend-card fade-in" id="t-${c.metric}" style="animation-delay:${i * 50}ms">
      <header class="trend-head">
        <h3>${escapeHtml(c.title)}</h3>
        <p class="subtitle">${escapeHtml(c.subtitle)}</p>
      </header>
      <div class="trend-stat" data-stat></div>
      <div class="trend-body"><span class="empty">Loading…</span></div>
    </article>`,
    ).join('')}</div>`;

  requestAnimationFrame(() => {
    for (const el of host.querySelectorAll('.fade-in')) {
      el.classList.add('fade-in--ready');
    }
  });

  for (const b of host.querySelectorAll('.range-ctl button')) {
    b.addEventListener('click', () => {
      const u2 = new URL(location);
      u2.searchParams.set('range', b.dataset.range);
      history.replaceState(null, '', u2);
      activate(host);
    });
  }

  await Promise.all(
    CHARTS.map(async (c) => {
      let data;
      try {
        data = await fetch(`/db/api/view/trends?metric=${c.metric}&range=${range}`).then((x) =>
          x.json(),
        );
      } catch (err) {
        data = { error: String(err) };
      }
      const card = host.querySelector(`#t-${c.metric}`);
      if (!card) return;
      const statEl = card.querySelector('[data-stat]');
      const body = card.querySelector('.trend-body');
      statEl.innerHTML = renderStat(c, data);
      body.innerHTML = renderChart(c, data);
    }),
  );
}

function flatTotal(data) {
  if (!data?.series) return 0;
  return data.series.reduce((sum, s) => sum + s.points.reduce((a, p) => a + (p.value ?? 0), 0), 0);
}
function bucketCount(data) {
  if (data?.points?.length) return data.points.length;
  if (data?.series?.[0]?.points?.length) return data.series[0].points.length;
  return 0;
}

function renderStat(spec, data) {
  if (data?.error) return '';
  const total = data?.points?.length
    ? data.points.reduce(
        (sum, b) => sum + Object.values(b.values || {}).reduce((s, v) => s + (Number(v) || 0), 0),
        0,
      )
    : flatTotal(data);
  const buckets = bucketCount(data);
  if (!buckets) return '';
  return `<div class="stat-row">
    <span class="stat-num">${formatNumber(total)}</span>
    <span class="stat-label">${formatStatLabel(spec.metric, total)}</span>
    <span class="stat-meta">across ${buckets} ${data.bucket || 'bucket'}${buckets === 1 ? '' : 's'}</span>
  </div>`;
}

function formatNumber(n) {
  if (Math.abs(n) >= 10000) return Math.round(n).toLocaleString();
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toFixed(2);
}

function formatStatLabel(metric, n) {
  const word = (s) => (n === 1 ? s : `${s}s`);
  switch (metric) {
    case 'activity-pulse':
      return word('event');
    case 'knowledge-growth':
      return 'new entities + knowledge';
    case 'event-source-mix':
      return word('event');
    case 'refusals-rate':
      return word('refusal');
    case 'top-entity-engagement':
      return word('mention');
    default:
      return word('event');
  }
}

function renderChart(spec, r) {
  if (r?.error) return `<p class="empty">Error: ${escapeHtml(r.error)}</p>`;
  if (spec.kind === 'small-multiples') {
    if (!r?.series?.length) return '<p class="empty">No engagement data yet.</p>';
    const rows = r.series
      .map((s) => ({
        label: s.name,
        total: s.points.reduce((a, p) => a + (p.value ?? 0), 0),
        values: s.points.map((p) => p.value ?? 0),
      }))
      .sort((a, b) => b.total - a.total);
    return renderSmallMultiples(rows, { rowHeight: 28, sparkWidth: 200 });
  }
  if (spec.kind === 'stacked') {
    if (!r?.points?.length)
      return '<p class="empty">Not enough data yet — needs at least 2 buckets.</p>';
    return renderStackedBarChart(r.points, r.series, { width: 720, height: 200 });
  }
  const series = r.series?.[0];
  if (!series?.points?.length)
    return '<p class="empty">Not enough data yet — needs at least 2 buckets.</p>';
  const values = series.points.map((p) => p.value);
  const labels = series.points.map((p) => String(p.bucket));
  return renderBarChart(values, labels, { width: 720, height: 200 });
}
