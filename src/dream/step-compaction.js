// step-compaction.js — Theme 1a. Dedup-via-supersedes + archive-via-tier.
// Runs in dream pipeline after step-scope-cleanup. Idempotent, fail-soft.

import { BoundQuery, surql } from 'surrealdb';
import { archiveMemo } from '../memory/archive.js';
import * as store from '../memory/store.js';

const DEFAULT_CFG = {
  semantic_threshold: 0.93,
  cluster_max_size: 8,
  dedup_enabled: true,
  archive_enabled: true,
  archive_thresholds: {
    knowledge: { age_days: 360, signal_max: 1 },
    habit: { age_days: 120, signal_max: 1 },
    thread: { age_days: 60 },
    prediction: { resolved_age_days: 730 },
  },
};

async function readConfig(db) {
  try {
    const [rows] = await db.query('SELECT VALUE value FROM runtime:`compaction.config`').collect();
    return rows?.[0] ?? DEFAULT_CFG;
  } catch {
    return DEFAULT_CFG;
  }
}

async function dedupExact(db) {
  const [groups] = await db
    .query(
      surql`SELECT content_hash, array::group(id) AS ids
            FROM memos
            WHERE kind = 'knowledge' AND content_hash IS NOT NONE
            GROUP BY content_hash`,
    )
    .collect();
  let merged = 0;
  let clusters = 0;
  for (const g of groups ?? []) {
    const ids = g.ids ?? [];
    if (ids.length < 2) continue;
    clusters++;
    // Pick canonical: highest signal_count*confidence; tiebreak earliest derived_at
    const [rows] = await db
      .query(
        new BoundQuery(
          `SELECT id, signal_count, confidence, derived_at FROM memos WHERE id IN $ids
           ORDER BY (signal_count * confidence) DESC, derived_at ASC`,
          { ids },
        ),
      )
      .collect();
    if (!rows || rows.length < 2) continue;
    const canonical = rows[0];
    for (const r of rows.slice(1)) {
      try {
        await store.relate(db, canonical.id, r.id, 'supersedes');
        merged++;
      } catch (e) {
        console.warn(`[step-compaction dedup] supersede failed: ${e.message}`);
      }
    }
  }
  return { merged, clusters };
}

async function archivePass(db, cfg) {
  const t = cfg.archive_thresholds ?? DEFAULT_CFG.archive_thresholds;
  const byKind = { knowledge: 0, habit: 0, thread: 0, prediction: 0 };
  const BATCH = 200;

  // knowledge: aged + low-signal + no derived_from from non-archived memos
  try {
    const cutoff = new Date(Date.now() - (t.knowledge?.age_days ?? 360) * 86_400_000);
    const sigMax = t.knowledge?.signal_max ?? 1;
    const [ks] = await db
      .query(
        surql`SELECT id FROM memos
              WHERE kind = 'knowledge'
                AND derived_at < ${cutoff}
                AND signal_count <= ${sigMax}
              LIMIT ${BATCH}`,
      )
      .collect();
    for (const m of ks ?? []) {
      await archiveMemo(db, m.id, 'stale_age');
      byKind.knowledge++;
    }
  } catch (e) {
    console.warn(`[step-compaction archive knowledge] ${e.message}`);
  }

  // habit
  try {
    const cutoff = new Date(Date.now() - (t.habit?.age_days ?? 120) * 86_400_000);
    const sigMax = t.habit?.signal_max ?? 1;
    const [hs] = await db
      .query(
        surql`SELECT id FROM memos
              WHERE kind = 'habit' AND derived_at < ${cutoff} AND signal_count <= ${sigMax}
              LIMIT ${BATCH}`,
      )
      .collect();
    for (const m of hs ?? []) {
      await archiveMemo(db, m.id, 'stale_age');
      byKind.habit++;
    }
  } catch (e) {
    console.warn(`[step-compaction archive habit] ${e.message}`);
  }

  // thread
  try {
    const cutoff = new Date(Date.now() - (t.thread?.age_days ?? 60) * 86_400_000);
    const [ts] = await db
      .query(
        surql`SELECT id FROM memos
              WHERE kind = 'thread' AND derived_at < ${cutoff}
              LIMIT ${BATCH}`,
      )
      .collect();
    for (const m of ts ?? []) {
      await archiveMemo(db, m.id, 'stale_age');
      byKind.thread++;
    }
  } catch (e) {
    console.warn(`[step-compaction archive thread] ${e.message}`);
  }

  // prediction (resolved + aged)
  try {
    const days = t.prediction?.resolved_age_days ?? 730;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const [ps] = await db
      .query(
        surql`SELECT id FROM memos
              WHERE kind = 'prediction'
                AND meta.resolved_at IS NOT NONE
                AND meta.resolved_at < ${cutoff}
              LIMIT ${BATCH}`,
      )
      .collect();
    for (const m of ps ?? []) {
      await archiveMemo(db, m.id, 'resolved_aged');
      byKind.prediction++;
    }
  } catch (e) {
    console.warn(`[step-compaction archive prediction] ${e.message}`);
  }

  return byKind;
}

export async function dreamStepCompaction(db) {
  const t0 = Date.now();
  const cfg = await readConfig(db);
  const summary = {
    dedup_clusters: 0,
    dedup_merged: 0,
    archived: 0,
    by_kind: { knowledge: 0, habit: 0, thread: 0, prediction: 0 },
    duration_ms: 0,
    errors: [],
  };
  if (cfg.dedup_enabled) {
    try {
      const r = await dedupExact(db);
      summary.dedup_merged = r.merged;
      summary.dedup_clusters = r.clusters;
    } catch (e) {
      summary.errors.push(`dedup: ${e.message}`);
    }
  }
  if (cfg.archive_enabled) {
    try {
      summary.by_kind = await archivePass(db, cfg);
      summary.archived = Object.values(summary.by_kind).reduce((a, b) => a + b, 0);
    } catch (e) {
      summary.errors.push(`archive: ${e.message}`);
    }
  }
  summary.duration_ms = Date.now() - t0;
  try {
    await db
      .query(new BoundQuery('CREATE compaction_telemetry CONTENT $s', { s: summary }))
      .collect();
  } catch (e) {
    console.warn(`[step-compaction telemetry] ${e.message}`);
  }
  return summary;
}
