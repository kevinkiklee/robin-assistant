// The detector arg is currently unused — reserved for future
// repeat-query suppression.

import { surql } from 'surrealdb';
import { recordStringId } from '../memory/edge-registry.js';
import * as store from '../memory/store.js';
import { getRecallConfig } from '../memory/store.js';
import {
  aboutEntitiesForMemos,
  entityBoostFromAboutIds,
  matchCatalogEntities,
  matchPriorTailEntities,
  readEntityCatalog,
  tokensOf,
} from './entities.js';
import { recall } from './engine.js';
import { mmrLite, score } from './rank.js';
import { cosineSim, loadVectorsForHits } from './vectors.js';

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
}) {
  const start = Date.now();
  const safeQuery = typeof query === 'string' ? query : '';
  const safePrior = typeof priorAssistant === 'string' ? priorAssistant : '';

  // Combine current prompt with the tail of the prior assistant turn so
  // recall can latch onto the in-flight thread of conversation.
  const priorTail =
    safePrior.length > PRIOR_TAIL_CHARS
      ? safePrior.slice(safePrior.length - PRIOR_TAIL_CHARS)
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

    const cfg = await getRecallConfig(db).catch(() => ({
      mmr_threshold: 0.92,
      mmr_threshold_legacy_substring: 0.85,
      mmr_use_cosine: true,
      entity_boost_enabled: true,
    }));

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
        _scored: score(h, { session_id: undefined, entityBoost, entityBoostCount }),
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

  const latency_ms = Date.now() - start;

  // Telemetry write — must never break the response.
  try {
    await db
      .query(
        surql`CREATE intuition_telemetry CONTENT ${{
          query_chars: safeQuery.length,
          hits: hits.length,
          tokens_injected: tokens,
          latency_ms,
          truncated,
          meta: {
            mmr_drops: mmrDropsOut,
            mmr_path: mmrPathOut,
            mmr_vec_coverage: mmrVecCoverageOut,
            entity_boost_applied: entityBoostAppliedOut,
            entity_boost_count: entityBoostCountOut,
            query_entities_matched: queryEntitiesMatchedOut,
          },
        }}`,
      )
      .collect();
  } catch {
    // Swallow — telemetry is advisory.
  }

  // recall_log: feeds the reinforcement loop. Best-effort.
  try {
    const rankedHits = hits.map((h, i) => ({
      record: h.id,
      kind: h._kind,
      // Reuse the components computed during the score-and-MMR pass so the
      // entity boost (A2) is reflected here, not recomputed without context.
      score_components: h._scored?.components ?? {},
      rank: i,
    }));
    await db
      .query(
        surql`CREATE recall_log CONTENT ${{
          query: safeQuery,
          session_id: sessionId ?? null,
          k,
          ranked_hits: rankedHits,
          outcome: 'pending',
          meta: {
            latency_ms,
            truncated,
            from: 'intuition',
            // Phase 11 cross-design fix: default focus_block fields so the
            // recall-eval harness can stratify metrics by them. D1 will
            // flip these to real values when it lands.
            focus_block_present: false,
            focus_block_tokens: 0,
          },
        }}`,
      )
      .collect();
  } catch {
    /* fail-soft */
  }

  return { block, hits: hits.length, tokens, latency_ms, truncated };
}
