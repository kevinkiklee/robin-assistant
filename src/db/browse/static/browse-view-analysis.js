// Analysis page — surfaces non-obvious things Robin has learned (v2 schema).
import { escapeHtml, formatTimeAgo } from '/db/static/browse-cards.js';

const CARDS = [
  {
    key: 'top-entities',
    title: 'top entities',
    subtitle: 'Mentioned most across events (last 90 days).',
  },
  {
    key: 'knowledge-by-topic',
    title: 'knowledge by topic',
    subtitle: 'How distilled knowledge clusters by topic.',
  },
  {
    key: 'rules-by-scope',
    title: 'rules by scope',
    subtitle: 'Active and deactivated rules grouped by scope.',
  },
  {
    key: 'refusals-by-surface',
    title: 'refusals by surface',
    subtitle: 'Where Robin has refused outbound actions most often (90d).',
  },
  {
    key: 'recall-usefulness',
    title: 'recall usefulness',
    subtitle: 'What fraction of recalls were used downstream (30d).',
  },
];

export async function activate(host) {
  host.innerHTML = `
    <div class="eyebrow"><span>view</span><span class="sep">·</span><span>analysis</span></div>
    <div class="head"><h1>analysis</h1></div>
    <div class="purpose">Surfaces non-obvious things Robin has learned about you. Cards load independently and may be empty if their data hasn't accumulated yet.</div>
    <div class="anly-grid">${CARDS.map(
      (
        c,
        i,
      ) => `<article class="anly-card fade-in" id="anly-${c.key}" style="animation-delay:${i * 40}ms">
      <h3>${escapeHtml(c.title)}</h3>
      <p class="subtitle">${escapeHtml(c.subtitle)}</p>
      <div class="anly-body"><span class="empty">Loading…</span></div>
    </article>`,
    ).join('')}</div>`;
  requestAnimationFrame(() => {
    for (const el of host.querySelectorAll('.fade-in')) {
      el.classList.add('fade-in--ready');
    }
  });

  await Promise.all(
    CARDS.map(async (c) => {
      let r;
      try {
        r = await fetch(`/db/api/view/analysis/${c.key}`).then((x) => x.json());
      } catch (err) {
        r = { error: String(err) };
      }
      const body = host.querySelector(`#anly-${c.key} .anly-body`);
      if (body) body.innerHTML = renderCardBody(c.key, r);
    }),
  );
}

function renderCardBody(key, r) {
  if (r?.error) return `<p class="empty">Error: ${escapeHtml(r.error)}</p>`;
  switch (key) {
    case 'top-entities':
      return renderTopEntities(r);
    case 'knowledge-by-topic':
      return renderBarRows(r.rows, 'topic', 'n', 'No knowledge yet.');
    case 'rules-by-scope':
      return renderRulesByScope(r);
    case 'refusals-by-surface':
      return renderBarRows(r.rows, 'surface', 'n', 'No refusals recorded.');
    case 'recall-usefulness':
      return renderRecallUsefulness(r);
    default:
      return '<p class="empty">No renderer.</p>';
  }
}

function renderTopEntities(r) {
  if (!r?.entities?.length)
    return '<p class="empty">No data yet — populated as events mention entities.</p>';
  return `<div class="anly-scroll"><ul class="tc-list">${r.entities
    .map(
      (c) => `<li>
    <a href="?tab=view&amp;page=entity&amp;entity=${encodeURIComponent(c.slug)}">${escapeHtml(c.name)}</a>
    <span class="count"><span class="badge kind" data-explain-category="entity-kind" data-explain-key="${escapeHtml(c.kind || '')}" tabindex="0">${escapeHtml(c.kind || '')}</span> ${c.count}</span>
  </li>`,
    )
    .join('')}</ul></div>`;
}

function renderBarRows(rows, labelKey, valueKey, emptyMsg) {
  if (!rows?.length) return `<p class="empty">${escapeHtml(emptyMsg || 'No data yet.')}</p>`;
  const top = rows.slice(0, 8);
  const max = Math.max(...top.map((r) => Number(r[valueKey]) || 0), 1);
  return `<ul class="hbar-list">${top
    .map(
      (r) => `<li>
    <span class="hbar-label">${escapeHtml(String(r[labelKey] ?? ''))}</span>
    <span class="hbar-track"><span class="hbar-fill" style="width:${(((Number(r[valueKey]) || 0) / max) * 100).toFixed(1)}%"></span></span>
    <span class="hbar-count">${r[valueKey]}</span>
  </li>`,
    )
    .join('')}</ul>`;
}

function renderRulesByScope(r) {
  if (!r?.rows?.length) return '<p class="empty">No rules yet.</p>';
  return `<div class="anly-scroll"><table class="ac-table">
    <thead><tr><th data-explain-category="rule-scope" data-explain-key="base" tabindex="0">scope</th><th data-explain-category="rule-state" data-explain-key="active" tabindex="0">state</th><th>count</th></tr></thead>
    <tbody>${r.rows
      .map(
        (row) => `<tr>
      <td><span class="badge dom" data-explain-category="rule-scope" data-explain-key="${escapeHtml(row.scope)}" tabindex="0">${escapeHtml(row.scope)}</span></td>
      <td><span class="badge ${row.state === 'active' ? '' : 'warn'}" data-explain-category="rule-state" data-explain-key="${escapeHtml(row.state)}" tabindex="0">${escapeHtml(row.state)}</span></td>
      <td>${row.n}</td>
    </tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}

function renderRecallUsefulness(r) {
  if (!r?.total) return '<p class="empty">No recall events recorded in the last 30 days.</p>';
  const pct = ((r.used / r.total) * 100).toFixed(0);
  return `<div class="prediction-stat"><div class="prediction-pct">${pct}%</div><div class="prediction-fraction">${r.used} / ${r.total} used</div></div>`;
}
