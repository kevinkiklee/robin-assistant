// conflicts.js — pure-function helpers for the B2 contradiction surfacing
// block at recall time. fetchContradictors is the only DB-touching function;
// the rest are pure.
//
// Suppression rule precedence (§5.2):
//   1. low_confidence  — either side below conflict_min_confidence
//   2. superseded      — either side has freshness === 0
//   3. both_blocked    — both sides isOutboundBlocked
//   4. stale           — max(hitTs, otherTs) older than conflict_max_age_days
//   5. capped          — applied at builder time, not per-pair
// First matching rule short-circuits.

import { BoundQuery } from 'surrealdb';
import { DAY_MS } from '../../config/time.js';
import { isOutboundBlocked } from '../memory/scope-registry.js';

function tsMs(x) {
  if (x instanceof Date) return x.getTime();
  if (typeof x === 'number') return x;
  return new Date(x).getTime();
}

/**
 * Apply suppression rules 1-4 to a single pair.
 * Rule 5 (cap) is enforced in buildConflictBlock, not here.
 *
 * @param {{ hitSide: object, otherSide: object }} pair
 * @param {Date} now
 * @param {object} cfg  — recall config (conflict_min_confidence, conflict_max_age_days)
 * @returns {{ keep: boolean, reason?: string, redactSide?: 'hit'|'other' }}
 */
export function applySuppression(pair, now, cfg) {
  const { hitSide, otherSide } = pair;
  const minConf = cfg.conflict_min_confidence ?? 0.4;
  const maxAgeDays = cfg.conflict_max_age_days ?? 30;

  // Rule 1 — low_confidence (precedence: highest).
  if ((hitSide.confidence ?? 0) < minConf || (otherSide.confidence ?? 0) < minConf) {
    return { keep: false, reason: 'low_confidence' };
  }

  // Rule 2 — superseded (freshness === 0).
  if ((hitSide.freshness ?? 1) === 0 || (otherSide.freshness ?? 1) === 0) {
    return { keep: false, reason: 'superseded' };
  }

  // Rule 3 — outbound-blocked. Uses isOutboundBlocked predicate from
  // scope-registry (NOT a literal 'private' string).
  const hitBlocked = isOutboundBlocked(hitSide.scope ?? 'global');
  const otherBlocked = isOutboundBlocked(otherSide.scope ?? 'global');
  if (hitBlocked && otherBlocked) {
    return { keep: false, reason: 'both_blocked' };
  }

  // Rule 4 — stale.
  const newest = Math.max(tsMs(hitSide.ts), tsMs(otherSide.ts));
  if ((tsMs(now) - newest) / DAY_MS > maxAgeDays) {
    return { keep: false, reason: 'stale' };
  }

  // Pair survived rules 1-4. If exactly one side is outbound-blocked, signal
  // the redaction case so the caller can render the blocked side as
  // "<private memo redacted>" per §5.1.
  if (hitBlocked && !otherBlocked) return { keep: true, redactSide: 'hit' };
  if (!hitBlocked && otherBlocked) return { keep: true, redactSide: 'other' };
  return { keep: true };
}

/**
 * Collapse self-pair duplicates (the same canonical edge returned by both
 * the in-side and out-side LET branches) by sorting the endpoint ids
 * lexicographically; truncate the deduped list to `cap`.
 *
 * @param {Array<{side: string|object, other: string|object}>} rawRows
 * @param {number} cap   — conflict_max_pairs_hydrated
 * @returns {{ pairs: Array, pairs_precap: number }}
 */
export function dedupeAndCapPairs(rawRows, cap) {
  const seen = new Set();
  const deduped = [];
  for (const row of rawRows) {
    const sideId = String(row.side);
    const otherId = String(row.other);
    const key = sideId < otherId ? `${sideId}|${otherId}` : `${otherId}|${sideId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  const pairs_precap = deduped.length;
  const pairs = cap > 0 && deduped.length > cap ? deduped.slice(0, cap) : deduped;
  return { pairs, pairs_precap };
}

const FETCH_QUERY = `
LET $contras_in = (
  SELECT { side: in, other: out } AS pair FROM edges
  WHERE kind = 'contradicts' AND in IN $hits
);
LET $contras_out = (
  SELECT { side: out, other: in } AS pair FROM edges
  WHERE kind = 'contradicts' AND out IN $hits
);
LET $contras = array::concat($contras_in, $contras_out);
LET $ids = array::distinct(array::concat(
  $contras.pair.side,
  $contras.pair.other
));
RETURN {
  pairs: $contras,
  memos: (SELECT id, content, ts, scope, confidence, derived_at, meta,
                 fn::freshness(id) AS freshness
          FROM memos WHERE id IN $ids)
};
`;

/**
 * Hydrate contradicting-memo pairs for the given in-view memo ids.
 * Fail-soft on any error — returns `{ pairs: [], pairs_precap: 0 }`.
 *
 * @param {object} db
 * @param {Array} memoIds  — memo record refs from the intuition fan-out's memoHits
 * @param {object} cfg     — recall config (conflict_max_pairs_hydrated)
 * @returns {Promise<{ pairs: Array<{hitSide:object, otherSide:object}>, pairs_precap: number }>}
 */
export async function fetchContradictors(db, memoIds, cfg) {
  try {
    if (!Array.isArray(memoIds) || memoIds.length === 0) {
      return { pairs: [], pairs_precap: 0 };
    }
    const cap = cfg.conflict_max_pairs_hydrated ?? 24;
    // SurrealDB multi-statement returns an array of per-statement results.
    // LET statements return null; the final RETURN payload sits at the tail.
    const results = await db.query(new BoundQuery(FETCH_QUERY, { hits: memoIds })).collect();
    const payload = Array.isArray(results) ? results[results.length - 1] : results;
    // Each row in payload.pairs is { pair: { side, other } } from the SELECT
    // projection — unwrap once.
    const rawRows = (payload?.pairs ?? []).map((r) => r.pair ?? r);
    const hydratedMemos = payload?.memos ?? [];

    const { pairs: dedupedRows, pairs_precap } = dedupeAndCapPairs(rawRows, cap);

    // Build a `String(id) -> memo` lookup so each pair can carry full
    // {confidence, ts, scope, content, freshness} on both sides.
    const memosById = new Map(hydratedMemos.map((m) => [String(m.id), m]));
    const pairs = [];
    for (const row of dedupedRows) {
      const hit = memosById.get(String(row.side));
      const other = memosById.get(String(row.other));
      if (!hit || !other) continue; // hydration miss — drop defensively
      pairs.push({ hitSide: hit, otherSide: other });
    }
    return { pairs, pairs_precap };
  } catch {
    return { pairs: [], pairs_precap: 0 };
  }
}

const LINE_CONTENT_CHARS = 120;
const CONFLICT_OPEN = '<!-- conflicts -->';
const CONFLICT_CLOSE = '<!-- /conflicts -->';
const CONFLICT_SEPARATOR = ' <-> ';
const REDACTED_LABEL = '<private memo redacted>';

function trimLine(s, max = LINE_CONTENT_CHARS) {
  if (typeof s !== 'string') return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max).trimEnd();
}

function formatDate(ts) {
  if (!ts) return '????-??-??';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '????-??-??';
  return d.toISOString().slice(0, 10);
}

function estimateTokens(s) {
  return Math.ceil((typeof s === 'string' ? s.length : 0) / 4);
}

const CONFLICT_FRAME_TOKENS = estimateTokens(`${CONFLICT_OPEN}\n${CONFLICT_CLOSE}\n`);

function renderLine(pair, redactSide) {
  const { hitSide, otherSide } = pair;
  const hitDate = formatDate(hitSide.ts);
  const otherDate = formatDate(otherSide.ts);
  const hitContent = redactSide === 'hit' ? REDACTED_LABEL : trimLine(hitSide.content ?? '');
  const otherContent = redactSide === 'other' ? REDACTED_LABEL : trimLine(otherSide.content ?? '');
  const hitConf = (hitSide.confidence ?? 0).toFixed(2);
  const otherConf = (otherSide.confidence ?? 0).toFixed(2);
  return `[memo ${hitDate}] ${hitContent}${CONFLICT_SEPARATOR}[memo ${otherDate}] ${otherContent} (conf ${hitConf}${CONFLICT_SEPARATOR}${otherConf})`;
}

// Pair orientation normalisation. fetchContradictors returns pairs whose
// `hitSide` matches the queried memoIds set, but downstream MMR may shrink
// that set to a smaller `visibleHitIdSet`. We re-orient so the visible side
// (the one the agent will see in <!-- relevant memory -->) is always
// `hitSide`. When both endpoints are visible (§2.4 self-pair branch), the
// higher-confidence side leads, with ties broken by newer ts, then by
// canonical id.
function normaliseSelfPair(p, visibleHitIdSet) {
  const hitVisible = visibleHitIdSet.has(String(p.hitSide.id));
  const otherVisible = visibleHitIdSet.has(String(p.otherSide.id));
  // One-side visible: ensure the visible side is hitSide so the in-view
  // filter downstream catches it.
  if (!hitVisible && otherVisible) {
    return { hitSide: p.otherSide, otherSide: p.hitSide };
  }
  if (hitVisible && !otherVisible) return p;
  if (!hitVisible && !otherVisible) return p;
  // Both visible — apply the §2.4 deterministic ordering.
  const { hitSide, otherSide } = p;
  const hc = hitSide.confidence ?? 0;
  const oc = otherSide.confidence ?? 0;
  if (oc > hc) return { hitSide: otherSide, otherSide: hitSide };
  if (oc === hc && tsMs(otherSide.ts) > tsMs(hitSide.ts)) {
    return { hitSide: otherSide, otherSide: hitSide };
  }
  if (
    oc === hc &&
    tsMs(otherSide.ts) === tsMs(hitSide.ts) &&
    String(otherSide.id) < String(hitSide.id)
  ) {
    return { hitSide: otherSide, otherSide: hitSide };
  }
  return p;
}

/**
 * @param {Array<{hitSide:object, otherSide:object}>} pairs
 * @param {Set<string>} visibleHitIdSet  — String(id) of memos in the greedy-packed relevant-memory hits
 * @param {Date} now
 * @param {object} cfg
 * @returns {{ block: string, surfaced: number, tokens: number,
 *             suppressed_by_rule: { low_confidence:int, superseded:int, both_blocked:int, stale:int, capped:int },
 *             redacted_one_side: number, truncated: boolean }}
 */
export function buildConflictBlock(pairs, visibleHitIdSet, now, cfg) {
  const cap = cfg.conflict_max_pairs_surfaced ?? 3;
  const budget = cfg.conflict_block_token_budget ?? 300;
  const counters = {
    low_confidence: 0,
    superseded: 0,
    both_blocked: 0,
    stale: 0,
    capped: 0,
  };
  let redacted = 0;

  // Pre-filter: hitSide must be in the agent's in-view set (§1.1 filter).
  // Normalise self-pairs first so the higher-confidence visible side leads.
  const inView = pairs
    .map((p) => normaliseSelfPair(p, visibleHitIdSet))
    .filter((p) => visibleHitIdSet.has(String(p.hitSide.id)));

  // Apply suppression rules 1-4.
  const survivors = [];
  for (const p of inView) {
    const r = applySuppression(p, now, cfg);
    if (!r.keep) {
      if (r.reason && counters[r.reason] !== undefined) counters[r.reason] += 1;
      continue;
    }
    survivors.push({ pair: p, redactSide: r.redactSide ?? null });
    if (r.redactSide) redacted += 1;
  }

  // Ordering (§2.3): max(confidence) desc, max(ts) desc, canonical id sort.
  survivors.sort((A, B) => {
    const Amax = Math.max(A.pair.hitSide.confidence ?? 0, A.pair.otherSide.confidence ?? 0);
    const Bmax = Math.max(B.pair.hitSide.confidence ?? 0, B.pair.otherSide.confidence ?? 0);
    if (Bmax !== Amax) return Bmax - Amax;
    const Ats = Math.max(tsMs(A.pair.hitSide.ts), tsMs(A.pair.otherSide.ts));
    const Bts = Math.max(tsMs(B.pair.hitSide.ts), tsMs(B.pair.otherSide.ts));
    if (Bts !== Ats) return Bts - Ats;
    const Akey = [String(A.pair.hitSide.id), String(A.pair.otherSide.id)].sort().join('|');
    const Bkey = [String(B.pair.hitSide.id), String(B.pair.otherSide.id)].sort().join('|');
    if (Akey < Bkey) return -1;
    if (Akey > Bkey) return 1;
    return 0;
  });

  // Rule 5 — cap.
  let kept;
  if (survivors.length > cap) {
    kept = survivors.slice(0, cap);
    counters.capped = survivors.length - cap;
  } else {
    kept = survivors;
  }

  // Greedy-pack under the token budget.
  const lines = [];
  let used = CONFLICT_FRAME_TOKENS;
  let truncated = false;
  for (const s of kept) {
    const line = renderLine(s.pair, s.redactSide);
    const lineTokens = estimateTokens(`${line}\n`);
    if (used + lineTokens > budget) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += lineTokens;
  }

  const surfaced = lines.length;
  if (surfaced === 0) {
    return {
      block: '',
      surfaced: 0,
      tokens: 0,
      suppressed_by_rule: counters,
      redacted_one_side: redacted,
      truncated,
    };
  }
  const block = `${CONFLICT_OPEN}\n${lines.join('\n')}\n${CONFLICT_CLOSE}`;
  return {
    block,
    surfaced,
    tokens: estimateTokens(block),
    suppressed_by_rule: counters,
    redacted_one_side: redacted,
    truncated,
  };
}
