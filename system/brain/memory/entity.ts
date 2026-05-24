import type { RobinDb } from './db.ts';

export interface EntityRow {
  id: number;
  type: string;
  canonical_name: string;
  profile: string | null;
  created_at: string;
  updated_at: string;
}

export function upsertEntity(
  db: RobinDb,
  type: string,
  canonicalName: string,
  profile?: string,
): EntityRow {
  const name = canonicalName.trim();
  // Deduplicate on the NORMALIZED name (case-insensitive), regardless of type.
  // Deterministic backstop behind the LLM disambiguation step: collapses variants
  // disambiguation misses — "leadforge" (project), "LeadForge" (tool), "Leadforge"
  // (thing) all resolve to one row. Prefer an exact (type, name) match; otherwise
  // reuse the oldest same-normalized-name entity (first-seen type wins). Without
  // this, dedup relied only on a type-scoped LIKE search + a flaky local LLM,
  // which produced thousands of case/type duplicates.
  const exact = db
    .prepare(`SELECT * FROM entities WHERE type = ? AND canonical_name = ?`)
    .get(type, name) as EntityRow | undefined;
  const existing =
    exact ??
    (db
      .prepare(`SELECT * FROM entities WHERE lower(canonical_name) = lower(?) ORDER BY id LIMIT 1`)
      .get(name) as EntityRow | undefined);
  if (existing) {
    if (profile && profile !== existing.profile) {
      db.prepare(`UPDATE entities SET profile = ?, updated_at = datetime('now') WHERE id = ?`).run(
        profile,
        existing.id,
      );
      return { ...existing, profile, updated_at: new Date().toISOString() };
    }
    return existing;
  }
  const info = db
    .prepare(`
    INSERT INTO entities (type, canonical_name, profile) VALUES (?, ?, ?)
  `)
    .run(type, name, profile ?? null);
  return db
    .prepare('SELECT * FROM entities WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as EntityRow;
}

export function findEntity(db: RobinDb, query: string, type?: string): EntityRow[] {
  if (type) {
    return db
      .prepare(`
      SELECT * FROM entities WHERE type = ? AND canonical_name LIKE ? ORDER BY canonical_name LIMIT 20
    `)
      .all(type, `%${query}%`) as EntityRow[];
  }
  return db
    .prepare(`
    SELECT * FROM entities WHERE canonical_name LIKE ? ORDER BY canonical_name LIMIT 20
  `)
    .all(`%${query}%`) as EntityRow[];
}

export function getEntity(db: RobinDb, id: number): EntityRow | null {
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined;
  return row ?? null;
}

export interface RelationRow {
  id: number;
  subject_id: number;
  predicate: string;
  object_id: number;
  ts: string;
  source_event_id: number | null;
}

export function addRelation(
  db: RobinDb,
  subjectId: number,
  predicate: string,
  objectId: number,
  sourceEventId?: number,
): number {
  const info = db
    .prepare(`
    INSERT INTO relations (subject_id, predicate, object_id, ts, source_event_id)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(subjectId, predicate, objectId, new Date().toISOString(), sourceEventId ?? null);
  return Number(info.lastInsertRowid);
}

export function relatedEntities(db: RobinDb, entityId: number, hops: number = 1): EntityRow[] {
  if (hops < 1) return [];
  const oneHop = db
    .prepare(`
    SELECT DISTINCT e.* FROM entities e
      JOIN relations r ON (r.subject_id = ? AND r.object_id = e.id)
                       OR (r.object_id = ? AND r.subject_id = e.id)
     WHERE e.id != ?
  `)
    .all(entityId, entityId, entityId) as EntityRow[];
  if (hops === 1) return oneHop;
  const seen = new Set([entityId, ...oneHop.map((e) => e.id)]);
  const further: EntityRow[] = [];
  for (const e of oneHop) {
    const next = relatedEntities(db, e.id, 1);
    for (const n of next) {
      if (!seen.has(n.id)) {
        seen.add(n.id);
        further.push(n);
      }
    }
  }
  return [...oneHop, ...further];
}
