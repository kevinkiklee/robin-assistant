// meta-recall-narrative.js — weekly internal job for D2 meta-cognition.
// Spec §1.4, §3. Pulls `recall_log` failures from the trailing 7 days,
// clusters them by shared `about` endpoints, calls one tier:'fast' LLM,
// writes a `kind='reasoning'` memo + 0-3 rule_candidates.
//
// Manifest: cognition/jobs/builtin/meta-recall-narrative.md
// Schedule: 0 5 * * 0 (Sunday 05:00 local time).

import { BoundQuery, RecordId, surql } from 'surrealdb';
import { createCandidate } from '../../dream/candidates.js';
import { note } from '../../memory/store.js';
import { clusterByAboutEndpoints } from '../../meta_cognition/cluster.js';
import { validateMetaCognitionOutput } from '../../meta_cognition/output.js';
import { buildUserPrompt, META_COGNITION_SYSTEM } from '../../meta_cognition/prompt.js';

const SECONDARY_OUTCOME = 'unused';

const DEFAULT_CFG = {
  enabled: false,
  min_corrections_threshold: 5,
  lookback_days: 7,
  max_corrected_rows: 200,
  max_unused_rows: 200,
  top_k_clusters: 3,
  min_cluster_size: 2,
  unused_signal_weight: 0.33,
  tier: 'fast',
  max_tokens_in: 3000,
  max_tokens_out: 1200,
  max_rules_per_run: 3,
  weekly_token_budget: 6000,
  private_scope_action: 'drop',
  reasoning_memo_scope: 'global',
};

export default async function runMetaRecallNarrative({ db, embedder, host }) {
  const startedAt = Date.now();
  const config = await readConfig(db);

  if (config.enabled === false) {
    await emitTelemetry(db, {
      outcome: 'skipped_disabled',
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({ ran: false, reason: 'disabled' });
  }

  // §1.2 gate.
  const correctedCount = await countCorrectedInWindow(db, config.lookback_days);
  if (correctedCount < config.min_corrections_threshold) {
    await emitTelemetry(db, {
      outcome: 'skipped_below_threshold',
      corrected_count: correctedCount,
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({
      ran: false,
      reason: 'below_threshold',
      corrected_count: correctedCount,
    });
  }

  // §3.1 input gathering.
  const correctedRows = await selectCorrectedRows(db, config);
  const unusedRows = await selectUnusedRows(db, config);
  const inputRows = mergeAndDedupRows(correctedRows, unusedRows);

  // §3.1 / §7 privacy filter — direct + one-hop transitive.
  let cleanRows;
  let droppedPrivate;
  try {
    const filtered = await filterPrivateScopeRows(db, inputRows);
    cleanRows = filtered.cleanRows;
    droppedPrivate = filtered.dropped;
    if (droppedPrivate > 0 && config.private_scope_action === 'fail') {
      await emitTelemetry(db, {
        outcome: 'error',
        corrected_count: correctedCount,
        unused_count: unusedRows.length,
        rows_after_privacy: cleanRows.length,
        dropped_private: droppedPrivate,
        error: 'private_scope_contamination',
        duration_ms: Date.now() - startedAt,
      });
      return JSON.stringify({ ran: false, reason: 'private_scope_contamination' });
    }
  } catch (err) {
    await emitTelemetry(db, {
      outcome: 'error',
      corrected_count: correctedCount,
      unused_count: unusedRows.length,
      error: String(err?.message ?? err),
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({ ran: false, reason: 'privacy_filter_error' });
  }

  if (cleanRows.length === 0) {
    await emitTelemetry(db, {
      outcome: 'no_clusters',
      corrected_count: correctedCount,
      unused_count: unusedRows.length,
      rows_after_privacy: 0,
      dropped_private: droppedPrivate,
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({ ran: false, reason: 'no_clusters' });
  }

  // §3.1c hydration.
  const hydrated = await hydrateRetrievedMemos(db, cleanRows);

  // §3.2 clustering with surface fallback.
  let clusters = clusterByAboutEndpoints(hydrated, config).map((c) => ({
    ...c,
    cluster_id: c.entity_id,
  }));
  if (clusters.length === 0) {
    clusters = surfaceFallbackClusters(cleanRows, config);
  }

  if (clusters.length === 0) {
    await emitTelemetry(db, {
      outcome: 'no_clusters',
      corrected_count: correctedCount,
      unused_count: unusedRows.length,
      rows_after_privacy: cleanRows.length,
      dropped_private: droppedPrivate,
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({ ran: false, reason: 'no_clusters' });
  }

  if (config.enabled === 'shadow') {
    await emitTelemetry(db, {
      outcome: 'shadow_complete',
      corrected_count: correctedCount,
      unused_count: unusedRows.length,
      rows_after_privacy: cleanRows.length,
      dropped_private: droppedPrivate,
      clusters: clusters.length,
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({
      ran: false,
      reason: 'shadow_mode',
      cluster_count: clusters.length,
    });
  }

  // §3.3 LLM + §3.4 writes wired in Task 5.5.
  await emitTelemetry(db, {
    outcome: 'shadow_complete', // placeholder until 5.5 lands
    corrected_count: correctedCount,
    unused_count: unusedRows.length,
    rows_after_privacy: cleanRows.length,
    dropped_private: droppedPrivate,
    clusters: clusters.length,
    duration_ms: Date.now() - startedAt,
  });
  return JSON.stringify({
    ran: false,
    reason: 'shadow_mode',
    cluster_count: clusters.length,
  });
}

async function selectCorrectedRows(db, config) {
  const days =
    Number.isInteger(config.lookback_days) && config.lookback_days > 0 ? config.lookback_days : 7;
  const [rows] = await db
    .query(
      new BoundQuery(
        `SELECT id, ts, session_id, query, ranked_hits, attribution, meta
         FROM recall_log
         WHERE outcome = 'corrected'
           AND ts > time::now() - ${days}d
         ORDER BY ts DESC
         LIMIT $cap`,
        { cap: config.max_corrected_rows },
      ),
    )
    .collect();
  return (rows ?? []).map((r) => ({ ...r, outcome: 'corrected' }));
}

async function selectUnusedRows(db, config) {
  // `ranked_hits[*].used CONTAINS false` only matches when B1 has populated
  // the `used` field. Pre-B1 the projection yields an empty list and the
  // CONTAINS is false — secondary query is empty by construction.
  const days =
    Number.isInteger(config.lookback_days) && config.lookback_days > 0 ? config.lookback_days : 7;
  try {
    const [rows] = await db
      .query(
        new BoundQuery(
          `SELECT id, ts, session_id, query, ranked_hits, attribution, meta
           FROM recall_log
           WHERE ts > time::now() - ${days}d
             AND attribution.mode != 'corrected'
             AND attribution.mode != 'off'
             AND ranked_hits[*].used CONTAINS false
           ORDER BY ts DESC
           LIMIT $cap`,
          { cap: config.max_unused_rows },
        ),
      )
      .collect();
    return (rows ?? []).map((r) => ({ ...r, outcome: SECONDARY_OUTCOME }));
  } catch {
    // Older engine without array projection — return empty. D2 still runs
    // on corrected-only signal.
    return [];
  }
}

function mergeAndDedupRows(corrected, unused) {
  // Corrected wins on dedup so weight stays at 1.0.
  const byId = new Map();
  for (const r of corrected) byId.set(String(r.id), r);
  for (const r of unused) if (!byId.has(String(r.id))) byId.set(String(r.id), r);
  return [...byId.values()];
}

async function readConfig(db) {
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`meta_cognition.config`')
      .collect();
    const v = rows?.[0] ?? {};
    return { ...DEFAULT_CFG, ...v };
  } catch {
    return { ...DEFAULT_CFG };
  }
}

async function countCorrectedInWindow(db, lookbackDays) {
  // Inline duration literal — `${n}d` resolves at SurrealQL parse time. We can't
  // bind a duration via $param because the engine doesn't coerce ints to
  // durations in arithmetic context. Validate `lookbackDays` first.
  const days = Number.isInteger(lookbackDays) && lookbackDays > 0 ? lookbackDays : 7;
  const [rows] = await db
    .query(
      `SELECT count() AS n FROM recall_log
        WHERE outcome = 'corrected'
          AND ts > time::now() - ${days}d
        GROUP ALL`,
    )
    .collect();
  return rows?.[0]?.n ?? 0;
}

async function emitTelemetry(db, fields) {
  try {
    await db.query(surql`CREATE meta_cognition_telemetry CONTENT ${fields}`).collect();
  } catch {
    // Best-effort — telemetry must not break the job.
  }
}

async function hydrateRetrievedMemos(db, rows) {
  const memoIds = new Set();
  for (const row of rows) {
    for (const hit of row.ranked_hits ?? []) {
      const ref = String(hit?.record ?? '');
      if (ref.startsWith('memos:')) memoIds.add(ref);
    }
  }
  const memoIdList = [...memoIds].map((s) => {
    const [tbl, key] = s.split(':');
    return new RecordId(tbl, key);
  });

  if (memoIdList.length === 0) {
    return {
      rows,
      aboutByMemoId: new Map(),
      entityNameById: new Map(),
      memoById: new Map(),
    };
  }

  // Memo content + meta.
  const [memoRows] = await db
    .query(
      new BoundQuery(
        'SELECT id, content, kind, scope, meta, derived_at FROM memos WHERE id IN $ids',
        { ids: memoIdList },
      ),
    )
    .collect();
  const memoById = new Map((memoRows ?? []).map((m) => [String(m.id), m]));

  // about-edges: edges where kind='about' and in IN memoIds.
  const [edgeRows] = await db
    .query(
      new BoundQuery("SELECT in, out FROM edges WHERE kind = 'about' AND in IN $ids", {
        ids: memoIdList,
      }),
    )
    .collect();
  const aboutByMemoId = new Map();
  for (const e of edgeRows ?? []) {
    const key = String(e.in);
    if (!aboutByMemoId.has(key)) aboutByMemoId.set(key, []);
    aboutByMemoId.get(key).push(String(e.out));
  }

  // Entity names for cluster labelling — only for the entities actually touched.
  const entityIds = [...new Set([...aboutByMemoId.values()].flat())];
  const entityRefs = entityIds.map((s) => {
    const [tbl, key] = s.split(':');
    return new RecordId(tbl, key);
  });
  let entityNameById = new Map();
  if (entityRefs.length > 0) {
    const [entRows] = await db
      .query(new BoundQuery('SELECT id, name FROM entities WHERE id IN $ids', { ids: entityRefs }))
      .collect();
    entityNameById = new Map((entRows ?? []).map((r) => [String(r.id), r.name]));
  }

  return { rows, aboutByMemoId, entityNameById, memoById };
}

function surfaceFallbackClusters(rows, config) {
  // Group by row.meta?.from (intuition vs mcp_recall vs unknown). Each
  // resulting "cluster" carries `surface` instead of `entity_id` so the
  // prompt builder phrases the question correctly. Rows with no memo hits
  // are skipped — they carry no signal for D2 to reason about.
  const bySurface = new Map();
  for (const row of rows) {
    const memoHits = (row.ranked_hits ?? []).filter((h) => {
      const ref = String(h?.record ?? '');
      return h?.kind === 'memo' || ref.startsWith('memos:');
    });
    if (memoHits.length === 0) continue;
    const surface = row.meta?.from ?? 'unknown';
    if (!bySurface.has(surface)) bySurface.set(surface, []);
    bySurface.get(surface).push(row);
  }
  const out = [];
  for (const [surface, member] of bySurface.entries()) {
    if (member.length < config.min_cluster_size) continue;
    out.push({
      cluster_id: `surface:${surface}`,
      surface,
      score: member.length,
      rows: member.slice(0, 10),
      memo_ids: [
        ...new Set(
          member.flatMap((r) =>
            (r.ranked_hits ?? [])
              .map((h) => String(h?.record ?? ''))
              .filter((ref) => ref.startsWith('memos:')),
          ),
        ),
      ],
    });
  }
  return out.slice(0, config.top_k_clusters);
}

async function filterPrivateScopeRows(db, rows) {
  if (rows.length === 0) return { cleanRows: [], dropped: 0 };

  // Gather all memo ids referenced by ranked_hits.
  const allMemoIds = new Set();
  for (const row of rows) {
    for (const hit of row.ranked_hits ?? []) {
      const ref = String(hit?.record ?? '');
      if (ref.startsWith('memos:')) allMemoIds.add(ref);
    }
  }
  if (allMemoIds.size === 0) return { cleanRows: rows, dropped: 0 };

  const memoIdList = [...allMemoIds].map((s) => {
    const [tbl, key] = s.split(':');
    return new RecordId(tbl, key);
  });

  // Direct private-scope memos.
  const [direct] = await db
    .query(
      new BoundQuery('SELECT id FROM memos WHERE id IN $ids AND scope = "private"', {
        ids: memoIdList,
      }),
    )
    .collect();
  const blockedDirect = new Set((direct ?? []).map((r) => String(r.id)));

  // Transitive: memos whose `->edges[kind=derived_from]->memos[scope=private]` is non-empty.
  // `edges` is a TYPE RELATION table with the kind as a discriminator field
  // (open-enum). Arrow traversal threads through the edges table; the
  // [WHERE kind=...] selects only the derived_from variant.
  let blockedTransitive = new Set();
  try {
    const [trans] = await db
      .query(
        new BoundQuery(
          `SELECT id FROM memos
            WHERE id IN $ids
              AND count(->edges[WHERE kind = 'derived_from']->memos[WHERE scope = 'private']) > 0`,
          { ids: memoIdList },
        ),
      )
      .collect();
    blockedTransitive = new Set((trans ?? []).map((r) => String(r.id)));
  } catch {
    // Older engine without arrow traversal — fall back to direct only.
  }

  const allBlocked = new Set([...blockedDirect, ...blockedTransitive]);
  if (allBlocked.size === 0) return { cleanRows: rows, dropped: 0 };

  const cleanRows = [];
  let dropped = 0;
  for (const row of rows) {
    const refs = (row.ranked_hits ?? [])
      .map((h) => String(h?.record ?? ''))
      .filter((ref) => ref.startsWith('memos:'));
    const isBlocked = refs.some((ref) => allBlocked.has(ref));
    if (isBlocked) {
      dropped += 1;
    } else {
      cleanRows.push(row);
    }
  }
  return { cleanRows, dropped };
}
