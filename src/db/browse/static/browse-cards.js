// Card-mode renderers and shared helpers for the DB browser (v2 schema).
// Schema-aware for events / entities / episodes / knowledge / rules.

export function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}

export function formatTimeAgo(input, now = new Date()) {
  if (input == null) return '';
  const t = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(t.getTime())) return '';
  const ms = now - t;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  if (ms < 7 * 86_400_000) return `${Math.floor(ms / 86_400_000)}d ago`;
  return t.toISOString().slice(0, 10);
}

export function formatDuration(start, end) {
  if (start == null || end == null) return '';
  const a = start instanceof Date ? start : new Date(start);
  const b = end instanceof Date ? end : new Date(end);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return '';
  const m = Math.max(0, Math.round((b - a) / 60_000));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${h}h ${r}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function resolveRecordChip(recordId) {
  if (typeof recordId !== 'string' || !recordId.includes(':')) return null;
  const idx = recordId.indexOf(':');
  const table = recordId.slice(0, idx);
  const id = recordId.slice(idx + 1);
  if (!/^[a-z_][a-z0-9_]*$/i.test(table) || !id) return null;
  if (table === 'entities') {
    return { table, id, label: id, href: `?tab=view&page=entity&entity=${encodeURIComponent(id)}` };
  }
  return {
    table,
    id,
    label: `${table}:${id}`,
    href: `?tab=tables&table=${encodeURIComponent(table)}&record=${encodeURIComponent(id)}`,
  };
}

const TS_FIELDS = [
  'ts',
  'created',
  'updated',
  'started_at',
  'ended_at',
  'opened_at',
  'closed_at',
  'biographed_at',
  'applied_at',
  'last_seen_at',
  'last_run_at',
  'next_run_at',
  'last_touched',
  'archived_at',
  'resolved_at',
  'date',
];
const HEADER_PREFERENCE = [
  'name',
  'title',
  'slug',
  'directive',
  'topic',
  'class',
  'host',
  'source',
];

function pickHeader(row) {
  for (const k of HEADER_PREFERENCE) if (row?.[k]) return String(row[k]);
  for (const [k, v] of Object.entries(row ?? {})) {
    if (k === 'id' || TS_FIELDS.includes(k) || k.endsWith('_at') || k.endsWith('_id')) continue;
    if (v == null || v === '') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  if (typeof row?.id === 'string') return row.id.split(':').slice(-1)[0];
  return '(unnamed)';
}

function isRecordIdLike(s) {
  return typeof s === 'string' && /^[a-z_][a-z0-9_]{0,63}:[A-Za-z0-9_-]+$/.test(s);
}

function formatValue(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'boolean') return v ? '✓' : '—';
  if (Array.isArray(v) || (typeof v === 'object' && !(v instanceof Date))) {
    if (v instanceof Date) return escapeHtml(v.toISOString());
    return `<details class="json"><summary>${escapeHtml(Array.isArray(v) ? `[${v.length}]` : '{…}')}</summary><pre>${escapeHtml(JSON.stringify(v, null, 2))}</pre></details>`;
  }
  if (isRecordIdLike(v)) {
    const chip = resolveRecordChip(v);
    if (chip)
      return `<a class="rec-chip" href="${chip.href}" data-table="${escapeHtml(chip.table)}" data-id="${escapeHtml(chip.id)}">${escapeHtml(chip.label)}</a>`;
  }
  if (typeof v === 'string' && v.length > 240) {
    return `<span class="trunc" data-full="${escapeHtml(v)}">${escapeHtml(v.slice(0, 240))}…</span>`;
  }
  return escapeHtml(String(v));
}

function renderTruncatedBody(s) {
  const text = String(s ?? '');
  if (text.length <= 240) return `<p class="body">${escapeHtml(text)}</p>`;
  return `<p class="body trunc" data-full="${escapeHtml(text)}">${escapeHtml(text.slice(0, 240))}… <button class="show-more" type="button">show more</button></p>`;
}

export function renderGenericCard(row, table) {
  const header = pickHeader(row);
  const tsParts = TS_FIELDS.filter((k) => row?.[k]).map(
    (k) =>
      `<span class="ts" title="${escapeHtml(row[k])}">${escapeHtml(k)}: ${escapeHtml(formatTimeAgo(row[k]))}</span>`,
  );
  const fields = Object.entries(row ?? {})
    .filter(
      ([k, v]) =>
        k !== 'id' && !TS_FIELDS.includes(k) && !k.endsWith('_at') && v !== null && v !== '',
    )
    .map(([k, v]) => {
      const formatted = formatValue(v);
      if (!formatted) return '';
      return `<div class="field"><span class="key">${escapeHtml(k)}</span> <span class="val">${formatted}</span></div>`;
    })
    .filter(Boolean)
    .join('');
  return `<article class="card generic" data-table="${escapeHtml(table)}" data-id="${escapeHtml(row?.id ?? '')}">
    <header class="card-h">${escapeHtml(header)}</header>
    <div class="card-ts">${tsParts.join(' · ')}</div>
    <div class="card-body">${fields}</div>
  </article>`;
}

function renderRecordLink(record, label) {
  const id = typeof record === 'string' ? record : (record?.id ?? '');
  const chip = resolveRecordChip(id);
  if (!chip) return '';
  return `<a class="chip rec-chip" href="${chip.href}">${escapeHtml(label || chip.label)}</a>`;
}

function renderEventCard(row) {
  const source = row.source || 'unknown';
  const time = row.ts
    ? `<span class="ts" title="${escapeHtml(row.ts)}">${escapeHtml(formatTimeAgo(row.ts))}</span>`
    : '';
  const sourceBadge = `<span class="badge source" data-explain-category="source" data-explain-key="${escapeHtml(source)}" tabindex="0">${escapeHtml(source)}</span>`;
  const body = renderTruncatedBody(row.content);
  const threadChip = row.thread ? renderRecordLink(row.thread, 'thread') : '';
  const biographedChip = row.biographed_at
    ? `<span class="chip">biographed</span>`
    : `<span class="chip warn">pending biographer</span>`;
  return `<article class="card event" data-id="${escapeHtml(row.id ?? '')}">
    <header class="card-h">${time} · ${sourceBadge}</header>
    <div class="card-body">${body}</div>
    <footer class="card-f">${threadChip}${biographedChip}</footer>
  </article>`;
}

function renderEpisodeCard(row) {
  const start = row.started_at;
  const end = row.ended_at;
  const dur = start && end ? formatDuration(start, end) : '';
  const range = start
    ? `${escapeHtml(formatTimeAgo(start))}${end ? ` → ${escapeHtml(formatTimeAgo(end))}` : ''}${dur ? ` (${escapeHtml(dur)})` : ''}`
    : '';
  const summary = row.summary ? renderTruncatedBody(row.summary) : '';
  return `<article class="card episode" data-id="${escapeHtml(row.id ?? '')}">
    <header class="card-h">${range}</header>
    <div class="card-body">
      <p class="title">${escapeHtml(row.title ?? '')}</p>
      ${summary}
    </div>
  </article>`;
}

function renderKnowledgeCard(row) {
  const topic = row.topic ?? 'uncategorized';
  const created = row.created
    ? `<span class="ts" title="${escapeHtml(row.created)}">${escapeHtml(formatTimeAgo(row.created))}</span>`
    : '';
  const confidence = row.confidence
    ? `<span class="badge conf" data-explain-category="confidence-level" data-explain-key="${escapeHtml(row.confidence)}" tabindex="0">${escapeHtml(row.confidence)}</span>`
    : '';
  return `<article class="card knowledge" data-id="${escapeHtml(row.id ?? '')}">
    <header class="card-h"><span class="badge dom">${escapeHtml(topic)}</span> · ${created} ${confidence}</header>
    <div class="card-body">${renderTruncatedBody(row.content)}</div>
  </article>`;
}

function renderRuleCard(row) {
  const state = row.state ?? 'active';
  const scope = row.scope ?? 'base';
  return `<article class="card rule" data-id="${escapeHtml(row.id ?? '')}">
    <header class="card-h"><span class="badge dom">${escapeHtml(scope)}</span> · <span class="badge ${state === 'active' ? '' : 'warn'}">${escapeHtml(state)}</span></header>
    <div class="card-body"><p class="rule">${escapeHtml(row.directive ?? '')}</p></div>
  </article>`;
}

function renderRuleCandidateCard(row) {
  const status = row.status ?? 'pending';
  const created = row.created
    ? `<span class="ts" title="${escapeHtml(row.created)}">${escapeHtml(formatTimeAgo(row.created))}</span>`
    : '';
  return `<article class="card rule-candidate" data-id="${escapeHtml(row.id ?? '')}">
    <header class="card-h"><span class="badge ${status === 'pending' ? 'warn' : ''}">${escapeHtml(status)}</span> · ${created}</header>
    <div class="card-body">
      <p class="wtd"><strong>${escapeHtml(row.directive ?? '')}</strong></p>
      ${row.rationale ? `<p class="wgw">${escapeHtml(row.rationale)}</p>` : ''}
    </div>
  </article>`;
}

function renderPatternCard(row) {
  const evidence =
    row.signal_count != null
      ? `<span class="chip">signals: ${escapeHtml(String(row.signal_count))}</span>`
      : '';
  const domain = row.domain ? `<span class="badge dom">${escapeHtml(row.domain)}</span>` : '';
  return `<article class="card pattern" data-id="${escapeHtml(row.id ?? '')}">
    <header class="card-h">${domain}</header>
    <div class="card-body"><p class="rule">${escapeHtml(row.pattern ?? '')}</p></div>
    <footer class="card-f">${evidence}</footer>
  </article>`;
}

function renderRefusalCard(row) {
  const surface = row.surface ?? 'unknown';
  const ts = row.ts
    ? `<span class="ts" title="${escapeHtml(row.ts)}">${escapeHtml(formatTimeAgo(row.ts))}</span>`
    : '';
  return `<article class="card refusal" data-id="${escapeHtml(row.id ?? '')}">
    <header class="card-h"><span class="badge source" data-explain-category="source" data-explain-key="${escapeHtml(surface)}" tabindex="0">${escapeHtml(surface)}</span> · ${ts}</header>
    <div class="card-body">
      <p class="wgw"><strong>${escapeHtml(row.action ?? '')}</strong></p>
      <p class="wtd">${escapeHtml(row.reason ?? '')}</p>
    </div>
  </article>`;
}

export const CARD_RENDERERS = {
  events: renderEventCard,
  episodes: renderEpisodeCard,
  knowledge: renderKnowledgeCard,
  rules: renderRuleCard,
  rule_candidates: renderRuleCandidateCard,
  patterns: renderPatternCard,
  refusals: renderRefusalCard,
};
