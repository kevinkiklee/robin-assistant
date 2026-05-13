// arcs.js — multi-episode containers. Theme 1b. Only writer to `arcs`.

import { BoundQuery } from 'surrealdb';

export function jaccard(a, b) {
  const A = new Set((a ?? []).map(String));
  const B = new Set((b ?? []).map(String));
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export async function createArc(db, { name, summary, entity_ids = [], tags = [], meta }) {
  const row = { entity_ids, tags };
  if (name) row.name = name;
  if (summary) row.summary = summary;
  if (meta) row.meta = meta;
  const [rows] = await db.query(new BoundQuery('CREATE arcs CONTENT $row', { row })).collect();
  return { id: rows?.[0]?.id ?? rows?.id };
}

export async function getArc(db, id) {
  const [rows] = await db.query(new BoundQuery('SELECT * FROM ONLY $id', { id })).collect();
  return rows?.[0] ?? rows ?? null;
}

export async function listArcs(db, { status, limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`listArcs: limit out of range [1,1000]: ${limit}`);
  }
  const ALLOWED_STATUS = new Set(['active', 'paused', 'closed']);
  if (status != null && !ALLOWED_STATUS.has(status)) {
    throw new Error(`listArcs: invalid status: ${status}`);
  }
  const sql = status
    ? `SELECT * FROM arcs WHERE status = $status ORDER BY last_activity_at DESC LIMIT ${limit}`
    : `SELECT * FROM arcs ORDER BY last_activity_at DESC LIMIT ${limit}`;
  const [rows] = await db.query(new BoundQuery(sql, status ? { status } : {})).collect();
  return rows ?? [];
}

export async function extendArc(db, arcId, { entity_ids = [], episode_ids = [] }) {
  const [rows] = await db.query(new BoundQuery('SELECT * FROM ONLY $id', { id: arcId })).collect();
  const arc = rows?.[0] ?? rows;
  if (!arc?.id) return null;
  const merged = Array.from(
    new Set([...(arc.entity_ids ?? []).map(String), ...entity_ids.map(String)]),
  );
  // Reactivate if paused
  const newStatus = arc.status === 'paused' ? 'active' : arc.status;
  await db
    .query(
      new BoundQuery(
        'UPDATE $id SET entity_ids = $ids, last_activity_at = time::now(), status = $s',
        { id: arcId, ids: merged, s: newStatus },
      ),
    )
    .collect();
  if (episode_ids.length > 0) {
    const existing = arc.meta?.episode_ids ?? [];
    const all = Array.from(new Set([...existing.map(String), ...episode_ids.map(String)]));
    await db
      .query(new BoundQuery('UPDATE $id SET meta.episode_ids = $eids', { id: arcId, eids: all }))
      .collect();
    // Also emit `arc_contains` graph edges (registry-validated post-alpha.17).
    // The meta.episode_ids array is preserved above as a defensive mirror.
    const { relateAll } = await import('./store.js');
    const rows = episode_ids.map((eid) => ({ from: arcId, to: eid, kind: 'arc_contains' }));
    await relateAll(db, rows).catch((e) => {
      // fail-soft: meta.episode_ids is authoritative if edges fail; log so the
      // failure isn't completely silent (helps when the edge registry tightens
      // and previously-accepted kinds start being rejected).
      console.warn(`extendArc: arc_contains edges failed for arc ${arcId}: ${e.message}`);
    });
  }
  return arc;
}

export async function readArcConfig(db) {
  try {
    const [rows] = await db.query('SELECT VALUE value FROM runtime:`arc.config`').collect();
    return (
      rows?.[0] ?? {
        auto_create_enabled: true,
        min_episodes: 2,
        min_shared_entities: 3,
        dedup_jaccard_threshold: 0.7,
        pause_after_idle_days: 14,
        close_after_idle_days: 60,
      }
    );
  } catch {
    return {
      auto_create_enabled: true,
      min_episodes: 2,
      min_shared_entities: 3,
      dedup_jaccard_threshold: 0.7,
      pause_after_idle_days: 14,
      close_after_idle_days: 60,
    };
  }
}
