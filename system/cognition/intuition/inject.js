// The detector arg is currently unused — reserved for future
// repeat-query suppression.

import { surql } from 'surrealdb';
import { readStateInferenceConfig } from '../jobs/internal/state-inference.js';
import { recordStringId } from '../memory/edge-registry.js';
import { isOutboundBlocked } from '../memory/scope-registry.js';
import { latestForSource } from '../memory/state_inference.js';
import * as store from '../memory/store.js';
import { getRecallConfig } from '../memory/store.js';
import { buildConflictBlock, fetchContradictors } from './conflicts.js';
import { recall } from './engine.js';
import {
  aboutEntitiesForMemos,
  entityBoostFromAboutIds,
  matchCatalogEntities,
  matchPriorTailEntities,
  readEntityCatalog,
  tokensOf,
} from './entities.js';
import { mmrLite, score } from './rank.js';
import { cosineSim, loadVectorsForHits } from './vectors.js';

const PRIOR_TAIL_CHARS = 500;
const LINE_CONTENT_CHARS = 120;

function trimLine(s, max = LINE_CONTENT_CHARS) {
  if (typeof s !== 'string') return '';
  // Collapse newlines/tabs so the line stays single-line.
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // Slice by code points to avoid splitting surrogate pairs at the boundary.
  return [...flat].slice(0, max).join('').trimEnd();
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

// Cognition D1: privileged "what is the user currently working on" block.
const FOCUS_OPEN = '<!-- current focus -->';
const FOCUS_CLOSE = '<!-- /current focus -->';
const FOCUS_TOKEN_BUDGET = 200;

export function humaniseDuration(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function buildFocusBlock(memo, { now = new Date() } = {}) {
  const ts = memo?.meta?.last_active_at;
  const lastActive = ts instanceof Date ? ts : new Date(ts);
  const dur = humaniseDuration(now.getTime() - lastActive.getTime());
  const conf = (memo?.confidence ?? 0).toFixed(2);
  const arcId = memo?.meta?.arc_id;
  const arcTag = arcId ? ` — arc:${String(arcId)}` : '';
  const body = `[focus, last active ${dur} ago, conf ${conf}] ${memo.content}${arcTag}`;
  return `${FOCUS_OPEN}\n${body}\n${FOCUS_CLOSE}`;
}

function keywordTokens(s) {
  return new Set(
    (typeof s === 'string' ? s : '')
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3),
  );
}

export function evaluateFocusSuppression({ cfg, memo, query, now = new Date() }) {
  if (cfg?.enabled !== true) return { suppressed: 'disabled' };
  if (!memo) return { suppressed: 'no_memo' };
  if (memo.scope && isOutboundBlocked(memo.scope)) return { suppressed: 'private' };
  const minConf = cfg.min_confidence_to_surface ?? 0.5;
  if ((memo.confidence ?? 0) < minConf) return { suppressed: 'low_confidence' };
  const lastActive = memo?.meta?.last_active_at ? new Date(memo.meta.last_active_at) : new Date(0);
  const ageMin = (now.getTime() - lastActive.getTime()) / 60_000;
  const staleMin = cfg.stale_after_minutes ?? 120;
  if (ageMin > staleMin) return { suppressed: 'stale' };
  // Defensive supersedes-leak check (rule 5): caller already filters via
  // latestForSource; if a `_superseded_count` was hydrated and > 0, suppress.
  if ((memo._superseded_count ?? 0) > 0) return { suppressed: 'superseded' };
  // Pivot detection (rule 6): zero keyword overlap with entities OR content.
  const qTokens = keywordTokens(query);
  if (qTokens.size === 0) return { suppressed: null };
  const cTokens = keywordTokens(memo.content);
  const entTokens = new Set();
  for (const e of memo?.meta?.entities ?? []) {
    for (const t of keywordTokens(String(e).split(':').slice(1).join('_'))) entTokens.add(t);
  }
  let intersect = 0;
  for (const t of qTokens) if (cTokens.has(t) || entTokens.has(t)) intersect++;
  if (intersect === 0) return { suppressed: 'pivot' };
  return { suppressed: null };
}

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
  source = null,
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

  // Cognition D1: focus block (computed at the prologue so it sits above the
  // relevant-memory block in the returned wire format). Always defined even
  // when suppressed so the wire shape stays consistent.
  let focus_block = '';
  let focus_tokens = 0;
  let focus_suppressed_reason = null;
  try {
    const siCfg = await readStateInferenceConfig(db);
    if (siCfg.enabled !== true) {
      focus_suppressed_reason = 'disabled';
    } else if (!source) {
      focus_suppressed_reason = 'no_memo';
    } else {
      const memo = await latestForSource(db, source);
      const sup = evaluateFocusSuppression({
        cfg: siCfg,
        memo,
        query: safeQuery,
        now: new Date(),
      });
      if (sup.suppressed) {
        focus_suppressed_reason = sup.suppressed;
        // Defensive supersedes-leak log (rule 5) — should never fire because
        // latestForSource already filters out superseded rows.
        if (sup.suppressed === 'superseded') {
          try {
            await db
              .query(
                surql`CREATE state_inference_telemetry CONTENT ${{
                  source,
                  outcome: 'error',
                  reason: 'supersedes_leak',
                }}`,
              )
              .collect();
          } catch {
            /* advisory */
          }
        }
      } else {
        const candidate = buildFocusBlock(memo);
        const candidateTokens = estimateTokens(candidate);
        if (candidateTokens <= FOCUS_TOKEN_BUDGET) {
          focus_block = candidate;
          focus_tokens = candidateTokens;
        } else {
          focus_suppressed_reason = 'over_budget';
        }
      }
    }
  } catch {
    // Fail-soft: never break the recall response.
    focus_suppressed_reason = 'error';
  }

  // Combine current prompt with the tail of the prior assistant turn so
  // recall can latch onto the in-flight thread of conversation.
  // Slice by code points to avoid cutting a surrogate pair at the boundary.
  const priorChars = [...safePrior];
  const priorTail =
    priorChars.length > PRIOR_TAIL_CHARS
      ? priorChars.slice(priorChars.length - PRIOR_TAIL_CHARS).join('')
      : safePrior;
  const combined = priorTail.length > 0 ? `${safeQuery}\n\n${priorTail}` : safeQuery;

  // Telemetry variables (declared in outer scope so the telemetry write below
  // can pick them up regardless of which path the merge/MMR block took).
  let mmrDropsOut = 0;
  let mmrPathOut = 'cosine';
  let mmrVecCoverageOut = 0;
  let entityBoostAppliedOut = false;
  let entityBoostCountOut = 0;
  let queryEntitiesMatchedOut = 0;

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
        .searchMemos(db, embedder, combined, {
          kind: ['knowledge', 'reasoning'],
          limit: k,
          since,
        })
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

    // A2: entity boost. Gated by cfg.entity_boost_enabled. Boosts memos
    // whose `about` edges point at entities matched by (a) the query
    // tokens against the catalog, unioned with (b) entities mentioned in
    // recent prior-tail biographed events (spec §3.1 candidates 1+2).
    let matchedEntityIds = new Set();
    let aboutByMemo = new Map();
    if (cfg.entity_boost_enabled !== false) {
      try {
        const catalog = await readEntityCatalog(db, cfg);
        const queryTokens = tokensOf(combined);
        const matched = matchCatalogEntities(catalog, queryTokens);
        const priorTailEnts = await matchPriorTailEntities(db, sessionId).catch(() => []);
        matchedEntityIds = new Set(matched.map((m) => String(m.id)));
        for (const e of priorTailEnts) matchedEntityIds.add(String(e.id));
        queryEntitiesMatchedOut = matchedEntityIds.size;
        const memoIdRefs = memoHits.map((h) => h.record.id);
        if (memoIdRefs.length > 0 && matchedEntityIds.size > 0) {
          aboutByMemo = await aboutEntitiesForMemos(db, memoIdRefs);
        }
      } catch {
        // Fail-soft: no boost applied.
      }
    }

    const merged = [...eventHits, ...memoHits].map((h) => {
      let entityBoost = 1.0;
      let entityBoostCount = 0;
      if (h._kind === 'memo' && matchedEntityIds.size > 0) {
        const memoKey = recordStringId(h.record.id);
        const aboutIds = aboutByMemo.get(memoKey) ?? new Set();
        const r = entityBoostFromAboutIds(aboutIds, matchedEntityIds, cfg);
        entityBoost = r.boost;
        entityBoostCount = r.count;
      }
      return {
        ...h,
        _scored: score(
          {
            record: h.record,
            distance: h.distance,
            contradictionCount: contraByHit.get(String(h.record.id)) ?? 0,
          },
          { session_id: undefined, entityBoost, entityBoostCount },
        ),
      };
    });
    merged.sort((a, b) => (b._scored.score ?? 0) - (a._scored.score ?? 0));

    // Capture A2 telemetry.
    for (const m of merged) {
      const eb = m._scored?.components?.entityBoost ?? 1.0;
      if (eb > 1.0) {
        entityBoostAppliedOut = true;
        entityBoostCountOut += 1;
      }
    }

    // A1: cosine-based MMR with batched vector hydration. Falls back to
    // substring overlap when vectors are unavailable or disabled.
    const eventIds = merged.filter((h) => h._kind === 'event').map((h) => h.record.id);
    const memoIds = merged.filter((h) => h._kind === 'memo').map((h) => h.record.id);

    let vectors = new Map();
    if (cfg.mmr_use_cosine !== false && merged.length >= 2) {
      try {
        vectors = await loadVectorsForHits(db, { eventIds, memoIds });
      } catch {
        vectors = new Map();
      }
    }
    const vecCoverage = merged.length === 0 ? 0 : vectors.size / merged.length;
    const useCosine = cfg.mmr_use_cosine !== false && vectors.size >= 2;
    let cosineFn;
    let threshold;
    let mmrPath;
    if (useCosine) {
      const vecAt = (h) => vectors.get(recordStringId(h.record.id));
      cosineFn = (a, b) => {
        const va = vecAt(a);
        const vb = vecAt(b);
        return va && vb ? cosineSim(va, vb) : 0;
      };
      threshold = cfg.mmr_threshold ?? 0.92;
      mmrPath = 'cosine';
    } else {
      cosineFn = (a, b) => substringOverlap(a.record.content, b.record.content);
      threshold = cfg.mmr_threshold_legacy_substring ?? 0.85;
      mmrPath = 'substring';
    }
    const dedupedAll = mmrLite(merged, cosineFn, threshold);
    const mmrDrops = merged.length - dedupedAll.length;
    const deduped = dedupedAll.slice(0, k);

    mmrDropsOut = mmrDrops;
    mmrPathOut = mmrPath;
    mmrVecCoverageOut = vecCoverage;

    hits = deduped.map((h) => ({
      id: h.record.id,
      source: h.record.source ?? (h._kind === 'memo' ? `memo:${h.record.kind}` : 'event'),
      content: h.record.content,
      ts: h.record.ts ?? h.record.derived_at,
      meta: h.record.meta ?? { kind: h._kind === 'memo' ? h.record.kind : undefined },
      dist: h.distance,
      _kind: h._kind,
      // B2 — carry the already-computed score components (with the wired
      // contradictionCount and A2 entityBoost) so the recall_log rebuild
      // doesn't re-invoke score() with stale args.
      _scoreComponents: h._scored?.components,
      _scored: h._scored,
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
      focus_tokens,
      focus_suppressed_reason,
      meta: {
        mmr_drops: mmrDropsOut,
        mmr_path: mmrPathOut,
        mmr_vec_coverage: mmrVecCoverageOut,
        entity_boost_applied: entityBoostAppliedOut,
        entity_boost_count: entityBoostCountOut,
        query_entities_matched: queryEntitiesMatchedOut,
      },
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
      // contradictionCount AND A2 entityBoost); fall back to a fresh
      // score() call for safety.
      score_components:
        h._scoreComponents ??
        h._scored?.components ??
        score({ record: h, distance: h.dist ?? 0 }).components,
      rank: i,
    }));
    const recallMeta = {
      latency_ms,
      truncated,
      from: 'intuition',
      focus_block_present: focus_block.length > 0,
      focus_block_tokens: focus_tokens,
    };
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

  // Wire format: focus block (D1) → conflicts block (B2) → relevant memory.
  // Block ordering is intentional — focus is highest-priority context, conflicts
  // come second since they help the agent adjudicate, relevant memory is last.
  const combined_block = [focus_block, conflictBlock, block].filter(Boolean).join('\n');
  return {
    block: combined_block,
    hits: hits.length,
    tokens: tokens + conflictTokens + focus_tokens,
    latency_ms,
    truncated: truncated || conflictBlockTruncated,
    focus_block,
    focus_tokens,
    focus_suppressed_reason,
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
