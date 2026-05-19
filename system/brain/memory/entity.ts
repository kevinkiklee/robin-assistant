import type { RobinDb } from './db.ts';

export interface EntityRow {
  id: number;
  type: string;
  canonical_name: string;
  profile: string | null;
  created_at: string;
  updated_at: string;
}

export function upsertEntity(db: RobinDb, type: string, canonicalName: string, profile?: string): EntityRow {
  const existing = db.prepare(`
    SELECT * FROM entities WHERE type = ? AND canonical_name = ?
  `).get(type, canonicalName) as EntityRow | undefined;
  if (existing) {
    if (profile && profile !== existing.profile) {
      db.prepare(`UPDATE entities SET profile = ?, updated_at = datetime('now') WHERE id = ?`).run(profile, existing.id);
      return { ...existing, profile, updated_at: new Date().toISOString() };
    }
    return existing;
  }
  const info = db.prepare(`
    INSERT INTO entities (type, canonical_name, profile) VALUES (?, ?, ?)
  `).run(type, canonicalName, profile ?? null);
  return db.prepare('SELECT * FROM entities WHERE id = ?').get(Number(info.lastInsertRowid)) as EntityRow;
}

export function findEntity(db: RobinDb, query: string, type?: string): EntityRow[] {
  if (type) {
    return db.prepare(`
      SELECT * FROM entities WHERE type = ? AND canonical_name LIKE ? ORDER BY canonical_name LIMIT 20
    `).all(type, `%${query}%`) as EntityRow[];
  }
  return db.prepare(`
    SELECT * FROM entities WHERE canonical_name LIKE ? ORDER BY canonical_name LIMIT 20
  `).all(`%${query}%`) as EntityRow[];
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

export function addRelation(db: RobinDb, subjectId: number, predicate: string, objectId: number, sourceEventId?: number): number {
  const info = db.prepare(`
    INSERT INTO relations (subject_id, predicate, object_id, ts, source_event_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(subjectId, predicate, objectId, new Date().toISOString(), sourceEventId ?? null);
  return Number(info.lastInsertRowid);
}

export function relatedEntities(db: RobinDb, entityId: number, hops: number = 1): EntityRow[] {
  if (hops < 1) return [];
  const oneHop = db.prepare(`
    SELECT DISTINCT e.* FROM entities e
      JOIN relations r ON (r.subject_id = ? AND r.object_id = e.id)
                       OR (r.object_id = ? AND r.subject_id = e.id)
     WHERE e.id != ?
  `).all(entityId, entityId, entityId) as EntityRow[];
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
