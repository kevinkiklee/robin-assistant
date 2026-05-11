// Per-entity profile page — activity-first (v2 schema).
import { CARD_RENDERERS, escapeHtml, formatTimeAgo } from '/db/static/browse-cards.js';

export async function activate(host) {
  const slug = new URLSearchParams(location.search).get('entity');
  if (!slug) {
    host.innerHTML = renderShell('(no entity)', '<p class="empty">No entity selected.</p>');
    return;
  }
  host.innerHTML = renderShell(slug, '<p class="page-body">Loading…</p>');
  let r;
  try {
    r = await fetch(`/db/api/view/entity/${encodeURIComponent(slug)}`);
  } catch (err) {
    host.innerHTML = renderShell(
      slug,
      `<p class="empty">Could not load entity: ${escapeHtml(String(err))}</p>`,
    );
    return;
  }
  if (r.status === 404) {
    host.innerHTML = renderShell(
      slug,
      `<p class="empty">Entity <code>${escapeHtml(slug)}</code> not found.</p>`,
    );
    return;
  }
  const d = await r.json();
  host.innerHTML = render(d);
}

function renderShell(label, content) {
  return `<div class="eyebrow"><span>view</span><span class="sep">·</span><span>profile</span></div>
    <div class="head"><h1>${escapeHtml(label)}</h1></div>
    ${content}`;
}

function render(d) {
  const e = d.entity ?? {};
  const events = (d.recent_events ?? []).map((row) => CARD_RENDERERS.events(row)).join('');
  const knowledge = (d.knowledge ?? []).map((row) => CARD_RENDERERS.knowledge(row)).join('');
  const connected = (d.connected_entities ?? [])
    .map(
      (c) =>
        `<a class="chip" href="?tab=view&amp;page=entity&amp;entity=${encodeURIComponent(c.slug)}">${escapeHtml(c.name)} · ${escapeHtml(c.kind || '')}</a>`,
    )
    .join('');
  return `
    <div class="eyebrow"><span>view</span><span class="sep">·</span><span>profile</span></div>
    <div class="head"><h1>${escapeHtml(e.name ?? '')}</h1></div>
    <div class="profile-meta">
      <span class="badge kind" data-explain-category="entity-kind" data-explain-key="${escapeHtml(e.kind || '')}" tabindex="0">${escapeHtml(e.kind || '')}</span>
      ${e.updated ? ` · updated ${escapeHtml(formatTimeAgo(e.updated))}` : ''}
    </div>
    ${e.summary ? `<div class="profile-summary">${escapeHtml(e.summary)}</div>` : ''}

    <h2 class="page-h">recent events</h2>
    <div>${events || '<p class="empty">no recent events</p>'}</div>

    <h2 class="page-h">connected entities</h2>
    <div class="chips-row">${connected || '<span class="empty">no connections yet</span>'}</div>

    ${knowledge ? `<h2 class="page-h">related knowledge</h2><div>${knowledge}</div>` : ''}
  `;
}
