// The detector arg is currently unused — reserved for future
// repeat-query suppression.

import { surql } from 'surrealdb';
import * as store from '../memory/store.js';
import { getRecallConfig } from '../memory/store.js';
import { buildConflictBlock, fetchContradictors } from './conflicts.js';
import { recall } from './engine.js';
import { mmrLite, score } from './rank.js';

const PRIOR_TAIL_CHARS = 500;
const LINE_CONTENT_CHARS = 120;

function trimLine(s, max = LINE_CONTENT_CHARS) {
  if (typeof s !== 'string') return '';
  // Collapse newlines/tabs so the line stays single-line.
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max).trimEnd();
}

function formatHitDate(ts) {
  if (!ts) return '????-??-??';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '????-??-??';
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function formatHit(hit) {
  const date = formatHitDate(hit.ts);
  const content = trimLine(hit.content ?? '');
  const kind = hit?.meta?.kind;
  const tag = kind === 'episode_summary' ? 'episode' : 'event';
  return `[${tag} ${date}] ${content}`;
}

// Rough token estimator: 1 token ≈ 4 chars. Same convention as the
// existing biographer prompt sizing.
function estimateTokens(s) {
  return Math.ceil((typeof s === 'string' ? s.length : 0) / 4);
}

// Cheap substring-overlap proxy for cosine similarity. Used by MMR-lite when
// we don't have embedding vectors in hand. Returns ∈ [0, 1].
function substringOverlap(a, b) {
  const sa = (typeof a === 'string' ? a : '').toLowerCase();
  const sb = (typeof b === 'string' ? b : '').toLowerCase();
  if (!sa || !sb) return 0;
  const tokensA = new Set(sa.split(/\W+/).filter((w) => w.length > 3));
  const tokensB = new Set(sb.split(/\W+/).filter((w) => w.length > 3));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersect = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersect++;
  return intersect / Math.min(tokensA.size, tokensB.size);
}

const OPEN = '<!-- relevant memory -->';
const CLOSE = '<!-- /relevant memory -->';
// Both markers + the two newlines between them and the body.
const FRAME_TOKENS = estimateTokens(`${OPEN}\n${CLOSE}\n`);

/**
 * Vector-search recent memory and format hits into an injection block.
 *
 * @param {object} args
 * @param {import('surrealdb').Surreal} args.db
 * @param {{embed:(t:string)=>Promise<Float32Array>}} args.embedder
 * @param {*} [args.detector]            Reserved for repeat-query suppression (4b).
 * @param {string} args.query             Current user message.
 * @param {string} [args.priorAssistant]  Previous assistant turn (we use the tail).
 * @param {number} [args.k]               Max hits (default 6).
 * @param {number} [args.recencyDays]     Recency window (default 30).
 * @param {number} [args.tokenBudget]     Total token cap for the block (default 1500).
 * @returns {Promise<{block:string, hits:number, tokens:number, latency_ms:number, truncated:boolean}>}
 */
export async function intuitionEndpoint({
  db,
  embedder,
  // detector — intentionally unused in 4a; see header comment.
  query,
  sessionId,
  priorAssistant = '',
  k = 6,
  recencyDays = 30,
  tokenBudget = 1500,
  conflictTokenBudget = 0,
}) {
  const start = Date.now();
  const safeQuery = typeof query === 'string' ? query : '';
  const safePrior = typeof priorAssistant === 'string' ? priorAssistant : '';

  // B2 — read recall config + resolve surfacing flag. Surfacing requires both
  // the runtime:recall flag AND a non-zero budget from the caller.
  const cfg = await getRecallConfig(db).catch(() => ({}));
  const surfacingOn = cfg.conflict_surfacing_enabled === true && conflictTokenBudget > 0;

  // Combine current prompt with the tail of the prior assistant turn so
  // recall can latch onto the in-flight thread of conversation.
  const priorTail =
    safePrior.length > PRIOR_TAIL_CHARS
      ? safePrior.slice(safePrior.length - PRIOR_TAIL_CHARS)
      : safePrior;
  const combined = priorTail.length > 0 ? `${safeQuery}\n\n${priorTail}` : safeQuery;

  let hits = [];
  // B2 — declared here so it's available below the if-block for
  // buildConflictBlock + telemetry. Default to empty when surfacing is off
  // or there are no hits.
  let conflictsHydration = { pairs: [], pairs_precap: 0 };
  if (combined.trim().length > 0) {
    const since = new Date(Date.now() - recencyDays * 86400_000);
    // Fan out: events (recall pipeline) + distilled knowledge memos. The
    // reinforcement loop only acts on memo:* hits, so fetching knowledge
    // here is what closes the loop. Both halves are bounded to k; we merge
    // and re-rank via score() then MMR-lite.
    const [eventResult, memoResult] = await Promise.all([
      recall(db, embedder, combined, { limit: k, since }),
      store
        .searchMemos(db, embedder, combined, { kind: 'knowledge', limit: k, since })
        .catch(() => ({ hits: [] })),
    ]);

    const eventHits = (eventResult?.hits ?? []).map((h) => ({
      record: h,
      distance: h.dist ?? 0,
      _kind: 'event',
    }));
    const memoHits = (memoResult?.hits ?? []).map((h) => ({
      record: h.record,
      distance: h.distance ?? 0,
      _kind: 'memo',
    }));

    // B2 — hydrate contradicting-memo pairs before the first score() call so
    // contradictionCount can be wired. Gated on surfacingOn + non-empty memos.
    if (surfacingOn && memoHits.length > 0) {
      const memoIds = memoHits.map((h) => h.record.id);
      conflictsHydration = await fetchContradictors(db, memoIds, cfg);
    }
    // contradicts is a symmetric relation — each pair contributes +1 to BOTH
    // endpoints' contradictionCount so contraPenalty fires on either memo if
    // it ranks into the agent's view.
    const contraByHit = new Map();
    for (const p of conflictsHydration.pairs) {
      const hk = String(p.hitSide.id);
      const ok = String(p.otherSide.id);
      contraByHit.set(hk, (contraByHit.get(hk) ?? 0) + 1);
      contraByHit.set(ok, (contraByHit.get(ok) ?? 0) + 1);
    }

    const merged = [...eventHits, ...memoHits].map((h) => ({
      ...h,
      _scored: score(
        {
          record: h.record,
          distance: h.distance,
          contradictionCount: contraByHit.get(String(h.record.id)) ?? 0,
        },
        { session_id: undefined },
      ),
    }));
    merged.sort((a, b) => (b._scored.score ?? 0) - (a._scored.score ?? 0));

    // MMR-lite: drop near-duplicates without re-embedding. Since we don't
    // have inline embeddings here, fall back to substring overlap as a
    // cheap proxy for cosine.
    const deduped = mmrLite(
      merged,
      (a, b) => substringOverlap(a.record.content, b.record.content),
      0.85,
    ).slice(0, k);

    hits = deduped.map((h) => ({
      id: h.record.id,
      source: h.record.source ?? (h._kind === 'memo' ? `memo:${h.record.kind}` : 'event'),
      content: h.record.content,
      ts: h.record.ts ?? h.record.derived_at,
      meta: h.record.meta ?? { kind: h._kind === 'memo' ? h.record.kind : undefined },
      dist: h.distance,
      _kind: h._kind,
      // B2 — carry the already-computed score components (with the wired
      // contradictionCount) so the recall_log rebuild doesn't re-invoke
      // score() with a stale {contradictionCount: 0}.
      _scoreComponents: h._scored?.components,
    }));
  }

  let block = '';
  let truncated = false;
  let tokens = 0;
  if (hits.length > 0) {
    // Greedy-pack lines under the token budget.
    const lines = [];
    let used = FRAME_TOKENS;
    for (const hit of hits) {
      const line = formatHit(hit);
      const lineTokens = estimateTokens(`${line}\n`);
      if (used + lineTokens > tokenBudget) {
        truncated = true;
        break;
      }
      lines.push(line);
      used += lineTokens;
    }
    if (lines.length < hits.length) truncated = true;
    if (lines.length > 0) {
      block = `${OPEN}\n${lines.join('\n')}\n${CLOSE}`;
      tokens = estimateTokens(block);
    } else {
      // Even a single hit didn't fit. Surface the truncation in telemetry
      // so we can tune token_budget; emit no block.
      truncated = true;
    }
  }

  // B2 — assemble the conflicts block from the hydrated pairs and the
  // greedy-packed in-view hit set. Fail-soft via buildConflictBlock's pure
  // return shape; an empty pairs list yields an empty block.
  let conflictBlock = '';
  let conflictTokens = 0;
  let conflictSurfaced = 0;
  let conflictSuppressedByRule = {
    low_confidence: 0,
    superseded: 0,
    both_blocked: 0,
    stale: 0,
    capped: 0,
  };
  let conflictRedactedOneSide = 0;
  let conflictBlockTruncated = false;
  if (surfacingOn && conflictsHydration.pairs.length > 0) {
    // The §1.1 filter: hitSide must be in greedy-packed `hits` (the agent
    // will actually see these memos in <!-- relevant memory -->).
    const visibleHitIds = new Set();
    for (const h of hits) {
      if (h._kind === 'memo') visibleHitIds.add(String(h.id));
    }
    const built = buildConflictBlock(conflictsHydration.pairs, visibleHitIds, new Date(), {
      conflict_min_confidence: cfg.conflict_min_confidence,
      conflict_max_age_days: cfg.conflict_max_age_days,
      conflict_max_pairs_surfaced: cfg.conflict_max_pairs_surfaced,
      conflict_block_token_budget: conflictTokenBudget,
    });
    conflictBlock = built.block;
    conflictTokens = built.tokens;
    conflictSurfaced = built.surfaced;
    conflictSuppressedByRule = built.suppressed_by_rule;
    conflictRedactedOneSide = built.redacted_one_side;
    conflictBlockTruncated = built.truncated;
  }

  const latency_ms = Date.now() - start;

  // Telemetry write — must never break the response.
  try {
    const telemetryContent = {
      query_chars: safeQuery.length,
      hits: hits.length,
      tokens_injected: tokens,
      latency_ms,
      truncated,
    };
    // B2 fields emitted only when the feature is on — keeps row shape
    // backwards-compatible for flag-off installs per spec §10.
    if (surfacingOn) {
      telemetryContent.conflicts_surfaced = conflictSurfaced;
      telemetryContent.conflicts_block_tokens = conflictTokens;
      telemetryContent.conflicts_hydrated_precap = conflictsHydration.pairs_precap;
      telemetryContent.conflicts_hydrated_postcap = conflictsHydration.pairs.length;
      telemetryContent.conflicts_hydration_capped =
        conflictsHydration.pairs_precap > conflictsHydration.pairs.length;
      telemetryContent.conflicts_suppressed_by_rule = conflictSuppressedByRule;
      telemetryContent.conflicts_redacted_one_side = conflictRedactedOneSide;
      telemetryContent.conflicts_block_truncated = conflictBlockTruncated;
    }
    await db.query(surql`CREATE intuition_telemetry CONTENT ${telemetryContent}`).collect();
  } catch {
    // Swallow — telemetry is advisory.
  }

  // recall_log: feeds the reinforcement loop. Best-effort.
  try {
    const rankedHits = hits.map((h, i) => ({
      record: h.id,
      kind: h._kind,
      // Prefer the already-computed components (wired with the correct
      // contradictionCount); fall back to a fresh score() call for safety.
      score_components:
        h._scoreComponents ?? score({ record: h, distance: h.dist ?? 0 }).components,
      rank: i,
    }));
    const recallMeta = { latency_ms, truncated };
    if (surfacingOn) recallMeta.conflicts_surfaced = conflictSurfaced;
    // session_id is option<string> — omit the key when absent so the schema
    // doesn't reject a NULL coercion (option<string> means string-or-missing,
    // not string-or-null).
    const recallContent = {
      query: safeQuery,
      k,
      ranked_hits: rankedHits,
      outcome: 'pending',
      meta: recallMeta,
    };
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      recallContent.session_id = sessionId;
    }
    await db.query(surql`CREATE recall_log CONTENT ${recallContent}`).collect();
  } catch {
    /* fail-soft */
  }

  const combined_block = conflictBlock ? `${conflictBlock}\n${block}` : block;
  return {
    block: combined_block,
    hits: hits.length,
    tokens: tokens + conflictTokens,
    latency_ms,
    truncated: truncated || conflictBlockTruncated,
    // Optional surface so the handler / D1 ordering can introspect.
    conflict_block: conflictBlock,
    conflict_tokens: conflictTokens,
    conflict_suppressed_count:
      conflictSuppressedByRule.low_confidence +
      conflictSuppressedByRule.superseded +
      conflictSuppressedByRule.both_blocked +
      conflictSuppressedByRule.stale +
      conflictSuppressedByRule.capped,
  };
}
