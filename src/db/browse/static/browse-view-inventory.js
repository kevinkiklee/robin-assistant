// Inventory page — Map of Memory.
// Layout: top-line summary → layer-summary tiles → expandable per-layer
// sections (open by default for non-internal layers) → optional architecture detail.
import { CARD_RENDERERS, escapeHtml, renderGenericCard } from '/db/static/browse-cards.js';

export async function activate(host) {
  host.innerHTML = `
    <div class="eyebrow"><span>view</span><span class="sep">·</span><span>inventory</span></div>
    <div class="head"><h1>inventory</h1></div>
    <div class="purpose">Plain-language map of every table Robin stores. Skim the layers; expand a section to see per-table samples.</div>
    <div class="page-body">Loading…</div>`;
  let info;
  let arch;
  try {
    [info, arch] = await Promise.all([
      fetch('/db/api/info').then((r) => r.json()),
      fetch('/db/api/architecture')
        .then((r) => r.json())
        .catch(() => null),
    ]);
  } catch (err) {
    host.innerHTML += `<p class="empty">Could not load inventory: ${escapeHtml(String(err))}</p>`;
    return;
  }

  const tables = info.tables;
  const totalRows = Object.values(info.counts ?? {}).reduce((s, n) => s + (n ?? 0), 0);
  const populatedTables = tables.filter((t) => (info.counts?.[t] ?? 0) > 0).length;

  const layerOrder = Array.isArray(arch?.layers)
    ? arch.layers.map((l) => l.id ?? l.name).filter(Boolean)
    : [];
  const layerMeta = new Map();
  for (const l of arch?.layers ?? []) {
    layerMeta.set(l.id ?? l.name, {
      name: l.name ?? l.id,
      summary: l.summary ?? l.description ?? '',
    });
  }

  const groups = {};
  for (const t of tables) {
    let layer = info.layers?.[t];
    if (!layer) layer = isInternal(t) ? 'OP' : 'other';
    if (!groups[layer]) groups[layer] = [];
    groups[layer].push(t);
  }
  const groupOrder = [...layerOrder, ...Object.keys(groups).filter((k) => !layerOrder.includes(k))];

  const layerTiles = groupOrder
    .filter((g) => groups[g]?.length)
    .map((g) => {
      const meta = layerMeta.get(g) ?? { name: g, summary: '' };
      const tablesInGroup = groups[g];
      const rowsInGroup = tablesInGroup.reduce((s, t) => s + (info.counts?.[t] ?? 0), 0);
      return `<a class="layer-tile" href="#layer-${escapeHtml(g)}">
        <div class="layer-tile-id">${escapeHtml(g)}</div>
        <div class="layer-tile-name">${escapeHtml(meta.name)}</div>
        <div class="layer-tile-stat"><strong>${tablesInGroup.length}</strong> tables · <strong>${rowsInGroup.toLocaleString()}</strong> rows</div>
      </a>`;
    })
    .join('');

  const summary = `
    <div class="inv-summary fade-in">
      <span><strong>${tables.length}</strong> tables</span>
      <span class="sep">·</span>
      <span><strong>${populatedTables}</strong> populated</span>
      <span class="sep">·</span>
      <span><strong>${totalRows.toLocaleString()}</strong> rows</span>
    </div>
    <div class="layer-tiles fade-in">${layerTiles}</div>`;

  const sectionsHtml = [];
  for (const g of groupOrder) {
    const tablesInGroup = groups[g];
    if (!tablesInGroup?.length) continue;
    const meta = layerMeta.get(g) ?? { name: g, summary: '' };
    const cards = await Promise.all(tablesInGroup.map((t) => renderTableCard(t, info)));
    const collapsedAttr = g === 'OP' ? '' : ' open';
    sectionsHtml.push(`<details class="inv-section fade-in" id="layer-${escapeHtml(g)}"${collapsedAttr}>
      <summary>
        <span class="inv-section-id" data-explain-category="layer" data-explain-key="${escapeHtml(g)}" tabindex="0">${escapeHtml(g)}</span>
        <span class="inv-section-name">${escapeHtml(meta.name)}</span>
        <span class="inv-section-count">${tablesInGroup.length} tables</span>
      </summary>
      ${meta.summary ? `<p class="inv-section-summary">${escapeHtml(meta.summary)}</p>` : ''}
      <div class="inv-grid">${cards.join('')}</div>
    </details>`);
  }

  host.innerHTML = `
    <div class="eyebrow"><span>view</span><span class="sep">·</span><span>inventory</span></div>
    <div class="head"><h1>inventory</h1></div>
    <div class="purpose">Plain-language map of every table Robin stores. Skim the layers; expand a section to see per-table samples.</div>
    ${summary}
    ${sectionsHtml.join('')}
    ${renderArchitectureDetails(arch)}`;

  requestAnimationFrame(() => {
    let i = 0;
    for (const el of host.querySelectorAll('.fade-in')) {
      el.style.animationDelay = `${i * 30}ms`;
      el.classList.add('fade-in--ready');
      i += 1;
    }
  });

  for (const a of host.querySelectorAll('.layer-tile')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = host.querySelector(a.getAttribute('href'));
      if (target) {
        target.open = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }
}

async function renderTableCard(table, info) {
  const count = info.counts?.[table] ?? 0;
  const desc = info.descriptions?.[table] || '';
  const sample = await fetchSample(table, info);
  const view = CARD_RENDERERS[table] ? 'cards' : 'rows';
  return `<article class="inv-card" data-table="${escapeHtml(table)}">
    <header>
      <a class="inv-card-name" href="?tab=workbench&amp;table=${encodeURIComponent(table)}&amp;view=${view}"><strong>${escapeHtml(table)}</strong></a>
      <span class="count">${count.toLocaleString()}</span>
    </header>
    ${desc ? `<p class="desc">${escapeHtml(desc)}</p>` : ''}
    <details class="inv-sample">
      <summary>sample</summary>
      <div class="sample">${sample}</div>
    </details>
  </article>`;
}

async function fetchSample(table, info) {
  if ((info.counts?.[table] ?? 0) === 0) {
    const hint = info.populates_when?.[table] || 'populates as Robin learns.';
    return `<p class="empty">(no rows yet) — ${escapeHtml(hint)}</p>`;
  }
  const sql = sampleSelect(table);
  let r;
  try {
    r = await fetch('/db/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    }).then((x) => x.json());
  } catch (err) {
    return `<p class="empty">(sample fetch failed: ${escapeHtml(String(err))})</p>`;
  }
  const row = r.responses?.[0]?.success
    ? Array.isArray(r.responses[0].result)
      ? r.responses[0].result[0]
      : r.responses[0].result
    : null;
  if (!row) return '<p class="empty">(no rows)</p>';
  const renderer = CARD_RENDERERS[table] ?? ((r) => renderGenericCard(r, table));
  return renderer(row);
}

function sampleSelect(table) {
  const orderByField = {
    events: 'ts',
    episodes: 'started_at',
    knowledge: 'created',
    threads: 'opened_at',
    refusals: 'ts',
  }[table];
  if (orderByField) {
    return `SELECT * FROM \`${table}\` ORDER BY ${orderByField} DESC LIMIT 1`;
  }
  return `SELECT * FROM \`${table}\` LIMIT 1`;
}

function isInternal(t) {
  return t.startsWith('_') || t.startsWith('runtime');
}

function renderArchitectureDetails(arch) {
  if (!arch || !Array.isArray(arch.layers) || !arch.layers.length) return '';
  const items = arch.layers
    .map((l) => {
      const id = l.id ?? l.name ?? '';
      const desc = l.summary ?? l.description ?? '';
      return `<li><strong data-explain-category="layer" data-explain-key="${escapeHtml(id)}" tabindex="0">${escapeHtml(id)}</strong> · <span class="layer-name">${escapeHtml(l.name ?? id)}</span>${desc ? `<p>${escapeHtml(desc)}</p>` : ''}</li>`;
    })
    .join('');
  return `<details class="arch-overview fade-in">
    <summary>how memory is organized</summary>
    <ul>${items}</ul>
  </details>`;
}
