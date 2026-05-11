// attribute.js — pure per-hit attribution. No DB access.
//
// Three passes in order: explicit (marker) -> citation ([event|episode YYYY-MM-DD])
// -> similarity (asymmetric Jaccard over content-word tokens). Hits matched by an
// earlier pass are skipped by later passes. Hits matched by no pass get used=false.

const EXPLICIT_RE = /<!--\s*recall_used:\s*([^>]+?)\s*-->/i;
const CITATION_RE = /\[(event|episode)\s+(\d{4})-(\d{2})-(\d{2})\]/g;
const SPLIT = '\n\nASSISTANT: ';

function hitRecordId(hit) {
  const v = hit.record ?? hit.memo_id ?? hit.event_id ?? hit.record_id;
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}

function hitTagForCitation(hit) {
  // 'event' for any event hit; 'episode' only for memos with meta.kind='episode_summary'
  // (mirrors inject.js:formatHit).
  if (hit.kind === 'event' || hit._kind === 'event') return 'event';
  const mk = hit?.meta?.kind;
  if (mk === 'episode_summary') return 'episode';
  return null; // memo hit with no citation tag — can only be similarity-matched
}

function dayDeltaUTC(tsLike, y, m, d) {
  const dateA = tsLike instanceof Date ? tsLike : new Date(tsLike);
  if (Number.isNaN(dateA.getTime())) return Number.POSITIVE_INFINITY;
  const a = Date.UTC(dateA.getUTCFullYear(), dateA.getUTCMonth(), dateA.getUTCDate());
  const b = Date.UTC(y, m - 1, d);
  return Math.abs(Math.round((a - b) / 86_400_000));
}

function tokenize(s) {
  if (typeof s !== 'string') return new Set();
  return new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
}

function extractAssistantBody(reply) {
  if (!reply || typeof reply !== 'string') return '';
  const idx = reply.indexOf(SPLIT);
  return idx >= 0 ? reply.slice(idx + SPLIT.length) : reply;
}

export function attribute(hits, replyOrBody, config) {
  // Defensive copy so callers can keep the input intact.
  const out = hits.map((h) => ({ ...h }));
  const body = extractAssistantBody(replyOrBody).toLowerCase();
  if (out.length === 0) return out;

  // ----- Pass 1: explicit marker -----
  const explicitMatch = EXPLICIT_RE.exec(replyOrBody ?? '');
  const explicitIds = explicitMatch
    ? new Set(
        explicitMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  if (explicitIds) {
    for (const h of out) {
      const id = hitRecordId(h);
      if (id && explicitIds.has(id)) {
        h.used = true;
        h.used_via = 'explicit';
      }
    }
  }

  // ----- Pass 2: citation -----
  const winDays = config.citation_date_window_days ?? 2;
  CITATION_RE.lastIndex = 0;
  const citations = [];
  for (const m of (replyOrBody ?? '').matchAll(CITATION_RE)) {
    citations.push({
      keyword: m[1],
      y: Number(m[2]),
      mo: Number(m[3]),
      d: Number(m[4]),
    });
  }
  for (const c of citations) {
    let best = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const h of out) {
      if (h.used) continue;
      const tag = hitTagForCitation(h);
      if (tag !== c.keyword) continue;
      if (!h.ts) continue;
      const delta = dayDeltaUTC(h.ts, c.y, c.mo, c.d);
      if (delta > winDays) continue;
      if (delta < bestDelta || (delta === bestDelta && (h.rank ?? 0) < (best?.rank ?? 0))) {
        best = h;
        bestDelta = delta;
      }
    }
    if (best) {
      best.used = true;
      best.used_via = 'citation';
    }
  }

  // tokenize/body retained for similarity pass added in Task 2.2.
  void body;
  void tokenize;

  // Hits still unmarked -> used=false; do not write used_via.
  for (const h of out) {
    if (h.used !== true) h.used = false;
  }

  return out;
}
