// eval.js — pure eval engine: scoreRows / replayRow / runEval.
//
// Stage-1: scoreRows() takes already-fetched rows + corrections
// and returns a full metrics object. No DB / IO.
//
// Stage-2: replayRow() re-scores hits against current state + embeddings.
//
// Stage-3: runEval() is DB-bound: scans recall_log within a window, optionally
// replays under current vectors/config, and returns a full rollup.

import { BoundQuery } from 'surrealdb';
import { embeddingTable, readProfile } from '../../data/embed/profile-router.js';
import { recordStringId } from '../memory/edge-registry.js';
import { labelHits } from './eval-labels.js';
import {
  meanRankOfNegatives,
  ndcgAtK,
  noSignalRate,
  precisionAtK,
  recallAtK,
} from './eval-metrics.js';
import { mmrLite, score } from './rank.js';
import { cosineSim } from './vectors.js';

const DEFAULT_KS = [1, 3, 6, 10];

function isPending(row) {
  return row?.outcome === 'pending';
}

function isEvaluated(row) {
  return row && row.outcome !== 'pending';
}

function metricsBlock(rows, ks) {
  const m = { no_signal_rate: undefined };
  for (const k of ks) {
    m[`precision_at_${k}`] = precisionAtK(rows, k);
    m[`recall_at_${k}`] = recallAtK(rows, k);
    m[`ndcg_at_${k}`] = ndcgAtK(rows, k);
  }
  m.mean_rank_of_negatives_at_10 = meanRankOfNegatives(rows);
  return m;
}

function focusBlockPresent(row) {
  return row?.meta?.focus_block_present === true;
}

/**
 * @param {{
 *   rows: Array<any>,
 *   corrections: Array<{ ts: any, sid?: string }>,
 *   ks?: number[],
 * }} args
 */
export function scoreRows({ rows, corrections = [], ks = DEFAULT_KS }) {
  const pending = rows.filter(isPending);
  const evaluated = rows.filter(isEvaluated);

  const labelled = evaluated.map((r) => labelHits(r, corrections));
  const metrics = metricsBlock(labelled, ks);
  metrics.no_signal_rate = noSignalRate(rows);

  // Phase 11 cross-design fix: stratify by focus_block_present.
  const withFb = [];
  const withoutFb = [];
  for (let i = 0; i < evaluated.length; i++) {
    if (focusBlockPresent(evaluated[i])) withFb.push(labelled[i]);
    else withoutFb.push(labelled[i]);
  }
  const metricsByFocus = {
    focus_block: { count: withFb.length, ...metricsBlock(withFb, ks) },
    no_focus_block: { count: withoutFb.length, ...metricsBlock(withoutFb, ks) },
  };

  return {
    rows_scored: evaluated.length,
    rows_pending: pending.length,
    rows_skipped: 0,
    metrics,
    metrics_by_focus_block: metricsByFocus,
  };
}

function hitRecordIdString(hit) {
  const v = hit?.record ?? hit?.memo_id ?? hit?.event_id ?? hit?.record_id;
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}

// Kendall tau over two rank-ordered ID lists. Returns NaN on length
// mismatch, 1.0 for n<2.
function kendallTau(originalOrder, replayedOrder) {
  if (originalOrder.length !== replayedOrder.length) return Number.NaN;
  const n = originalOrder.length;
  if (n < 2) return 1;
  const rank = new Map();
  replayedOrder.forEach((id, i) => rank.set(id, i));
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const ri = rank.get(originalOrder[i]);
      const rj = rank.get(originalOrder[j]);
      if (ri == null || rj == null) continue;
      if (ri < rj) concordant += 1;
      else if (ri > rj) discordant += 1;
    }
  }
  const denom = (n * (n - 1)) / 2;
  return denom === 0 ? 1 : (concordant - discordant) / denom;
}

/**
 * Re-score one historical recall_log row against current state.
 *
 * Returns:
 *   { skipped: true, reason }  when records or vectors are missing.
 *   { skipped: false, replayed_hits: [{ id, score, components }],
 *     kendall_tau: number }    otherwise.
 *
 * MCP-recall rows (meta.from='mcp_recall') skip A2 entity boost; A1 cosine
 * MMR still applies (spec §3.5). When `config.entity_boost_enabled` is
 * true, the caller passes `matchedEntityIds` (a Set<string>) and
 * `aboutByMemo` (a Map<string, Set<string>>) so this function can
 * compute the boost per hit without re-fetching the catalog.
 */
export async function replayRow({
  row,
  embedder,
  hydratedRecords,
  currentVectors,
  config,
  matchedEntityIds = null,
  aboutByMemo = null,
}) {
  const hits = Array.isArray(row?.ranked_hits) ? row.ranked_hits : [];
  if (hits.length === 0) return { skipped: true, reason: 'no_hits' };

  const ids = hits.map(hitRecordIdString).filter(Boolean);

  for (const id of ids) {
    if (!hydratedRecords.has(id)) return { skipped: true, reason: 'record_missing' };
  }

  const haveAnyVector = ids.some((id) => currentVectors.has(id));
  if (!haveAnyVector) return { skipped: true, reason: 'vectors_missing' };

  const qvec = await embedder.embed(row.query ?? '');

  const entityBoostOn =
    config?.entity_boost_enabled !== false && matchedEntityIds && matchedEntityIds.size > 0;

  const scored = [];
  for (const hit of hits) {
    const id = hitRecordIdString(hit);
    const rec = hydratedRecords.get(id);
    const vec = currentVectors.get(id);
    const distance = vec ? 1 - cosineSim(qvec, vec) : (hit.dist ?? 1);
    let entityBoost = 1.0;
    let entityBoostCount = 0;
    if (entityBoostOn && id?.startsWith('memos:')) {
      const aboutIds = aboutByMemo?.get(id) ?? new Set();
      let overlap = 0;
      for (const eid of aboutIds) if (matchedEntityIds.has(eid)) overlap++;
      const per = config.entity_boost_per_overlap ?? 0.1;
      const max = config.entity_boost_max ?? 1.25;
      entityBoost = overlap === 0 ? 1.0 : Math.min(max, 1.0 + per * overlap);
      entityBoostCount = overlap;
    }
    const s = score(
      { record: rec, distance, supersededCount: 0, contradictionCount: 0 },
      { entityBoost, entityBoostCount },
    );
    scored.push({ id, score: s.score, components: s.components });
  }
  scored.sort((a, b) => b.score - a.score);

  const useCosine = config?.mmr_use_cosine !== false;
  const threshold = useCosine
    ? (config?.mmr_threshold ?? 0.92)
    : (config?.mmr_threshold_legacy_substring ?? 0.85);
  const cosineFn = useCosine
    ? (a, b) => {
        const va = currentVectors.get(a.id);
        const vb = currentVectors.get(b.id);
        return va && vb ? cosineSim(va, vb) : 0;
      }
    : () => 0;
  const deduped = mmrLite(scored, cosineFn, threshold);

  const originalOrder = ids;
  const replayedOrder = deduped.map((h) => h.id);
  const tau = kendallTau(originalOrder, replayedOrder);

  return { skipped: false, replayed_hits: deduped, kendall_tau: tau };
}

const REINFORCE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Run the eval harness against the live DB.
 *
 * @param {object} args
 * @param {import('surrealdb').Surreal} args.db
 * @param {{embed:(t:string)=>Promise<Float32Array>}|null} args.embedder  Required iff replay=true.
 * @param {Date} args.windowStart
 * @param {Date} args.windowEnd
 * @param {string} args.profile             Active embedding profile name.
 * @param {'intuition'|'mcp_recall'|'all'} args.sourceFilter
 * @param {boolean} args.replay
 * @param {number} args.limit
 * @param {number[]} [args.ks]
 * @returns {Promise<{
 *   rows_scored: number, rows_pending: number, rows_skipped: number,
 *   rows_with_null_session_total: number,
 *   rows_with_null_session_evaluated: number,
 *   metrics: object, metrics_by_focus_block: object,
 *   replay_kendall_mean?: number|null,
 *   per_source: object,
 * }>}
 */
export async function runEval(args) {
  const { db, embedder, windowStart, windowEnd, profile, sourceFilter, replay, limit, ks } = args;
  if (replay && !embedder) throw new Error('replay mode requires an embedder');

  // Source filter via meta.from with a session_id-based fallback (spec §1.1).
  const sourceClause =
    sourceFilter === 'intuition'
      ? `AND (meta.from = 'intuition' OR (meta.from IS NONE AND session_id IS NONE))`
      : sourceFilter === 'mcp_recall'
        ? `AND (meta.from = 'mcp_recall' OR (meta.from IS NONE AND session_id IS NOT NONE))`
        : '';
  const sql = `SELECT id, ts, session_id, query, k, ranked_hits, outcome, meta
     FROM recall_log
     WHERE ts >= $start AND ts < $end ${sourceClause}
     ORDER BY ts ASC
     LIMIT $limit`;
  const [rows] = await db
    .query(new BoundQuery(sql, { start: windowStart, end: windowEnd, limit }))
    .collect();

  // Fetch corrections in the union window.
  let unionStart = Number.POSITIVE_INFINITY;
  let unionEnd = Number.NEGATIVE_INFINITY;
  for (const r of rows ?? []) {
    const t = (r.ts instanceof Date ? r.ts : new Date(r.ts)).getTime();
    if (t < unionStart) unionStart = t;
    if (t + REINFORCE_WINDOW_MS > unionEnd) unionEnd = t + REINFORCE_WINDOW_MS;
  }
  let corrections = [];
  if (rows && rows.length > 0) {
    try {
      const [cRows] = await db
        .query(
          new BoundQuery(
            `SELECT ts, meta.session_id AS sid FROM events
             WHERE meta.kind = 'correction' AND ts >= $a AND ts <= $b`,
            { a: new Date(unionStart), b: new Date(unionEnd) },
          ),
        )
        .collect();
      corrections = cRows ?? [];
    } catch {
      corrections = [];
    }
  }

  const result = scoreRows({ rows: rows ?? [], corrections, ks });
  // Report both counts: total (all rows in window) and evaluated-only
  // (excludes pending).
  result.rows_with_null_session_total = (rows ?? []).filter((r) => r.session_id == null).length;
  result.rows_with_null_session_evaluated = (rows ?? []).filter(
    (r) => r.session_id == null && r.outcome !== 'pending',
  ).length;

  // per_source breakdown over `_sources` arrays on ranked_hits[*].
  const perSource = { knn: { hits: 0 }, bm25: { hits: 0 }, knn_bm25: { hits: 0 } };
  for (const r of rows ?? []) {
    for (const h of r.ranked_hits ?? []) {
      const sources = Array.isArray(h._sources) ? h._sources : [];
      if (sources.includes('knn') && sources.includes('bm25')) perSource.knn_bm25.hits += 1;
      else if (sources.includes('knn')) perSource.knn.hits += 1;
      else if (sources.includes('bm25')) perSource.bm25.hits += 1;
    }
  }
  result.per_source = perSource;

  if (replay) {
    let tauSum = 0;
    let tauCount = 0;
    let skipped = 0;
    for (const row of rows ?? []) {
      if (row.outcome === 'pending') continue;
      const ids = (row.ranked_hits ?? [])
        .map((h) => (typeof h.record === 'string' ? h.record : String(h.record)))
        .filter(Boolean);
      if (ids.length === 0) continue;

      const eventIds = ids.filter((id) => id.startsWith('events:'));
      const memoIds = ids.filter((id) => id.startsWith('memos:'));

      const hydrated = new Map();
      if (eventIds.length > 0) {
        const [r] = await db
          .query(new BoundQuery(`SELECT * FROM events WHERE id IN $ids`, { ids: eventIds }))
          .collect();
        for (const evt of r ?? []) hydrated.set(recordStringId(evt.id), evt);
      }
      if (memoIds.length > 0) {
        const [r] = await db
          .query(new BoundQuery(`SELECT * FROM memos WHERE id IN $ids`, { ids: memoIds }))
          .collect();
        for (const m of r ?? []) hydrated.set(recordStringId(m.id), m);
      }

      const vectors = new Map();
      if (eventIds.length > 0) {
        const tbl = embeddingTable(profile, 'events');
        const [vr] = await db
          .query(
            new BoundQuery(`SELECT record, vector FROM ${tbl} WHERE record IN $ids`, {
              ids: eventIds,
            }),
          )
          .collect();
        for (const v of vr ?? []) vectors.set(recordStringId(v.record), Float32Array.from(v.vector));
      }
      if (memoIds.length > 0) {
        const tbl = embeddingTable(profile, 'memos');
        const [vr] = await db
          .query(
            new BoundQuery(`SELECT record, vector FROM ${tbl} WHERE record IN $ids`, {
              ids: memoIds,
            }),
          )
          .collect();
        for (const v of vr ?? []) vectors.set(recordStringId(v.record), Float32Array.from(v.vector));
      }

      // Intuition-source rows replay with A2 enabled; MCP-recall rows
      // skip A2 because the live MCP path never applied it (spec §3.5).
      const effectiveFrom =
        row?.meta?.from ?? (row?.session_id == null ? 'intuition' : 'mcp_recall');
      const replayConfig = {
        mmr_threshold: 0.92,
        mmr_use_cosine: true,
        entity_boost_enabled: effectiveFrom !== 'mcp_recall',
        entity_boost_per_overlap: 0.1,
        entity_boost_max: 1.25,
      };

      // When A2 is on, compute the same matched-entity context the
      // live inject.js path would.
      let matchedEntityIds = null;
      let aboutByMemo = null;
      if (replayConfig.entity_boost_enabled) {
        const { readEntityCatalog, matchCatalogEntities, tokensOf, aboutEntitiesForMemos } =
          await import('./entities.js');
        const catalog = await readEntityCatalog(db, replayConfig).catch(() => []);
        const tokens = tokensOf(row.query ?? '');
        const matched = matchCatalogEntities(catalog, tokens);
        matchedEntityIds = new Set(matched.map((m) => String(m.id)));
        if (memoIds.length > 0 && matchedEntityIds.size > 0) {
          aboutByMemo = await aboutEntitiesForMemos(db, memoIds).catch(() => new Map());
        }
      }

      const replayOut = await replayRow({
        row,
        embedder,
        hydratedRecords: hydrated,
        currentVectors: vectors,
        config: replayConfig,
        matchedEntityIds,
        aboutByMemo,
      });
      if (replayOut.skipped) {
        skipped += 1;
        continue;
      }
      if (Number.isFinite(replayOut.kendall_tau)) {
        tauSum += replayOut.kendall_tau;
        tauCount += 1;
      }
    }
    result.replay_kendall_mean = tauCount === 0 ? null : tauSum / tauCount;
    result.rows_skipped = skipped;
  }

  return result;
}

export { readProfile };
