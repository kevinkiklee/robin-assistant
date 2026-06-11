import type { RobinDb } from './db.ts';

export interface EntityRow {
  id: number;
  type: string;
  canonical_name: string;
  profile: string | null;
  profile_generated_at: string | null;
  created_at: string;
  updated_at: string;
}

const VALID_ENTITY_TYPES = new Set([
  'person',
  'place',
  'restaurant',
  'organization',
  'company',
  'service',
  'product',
  'gear',
  'camera',
  'lens',
  'financial_account',
  'medication',
  'event',
  'project',
  'library',
  'tool',
  'book',
  'film',
  'album',
  'artist',
  'species',
  'topic',
  'thing',
]);

export function normalizeEntityType(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (VALID_ENTITY_TYPES.has(lower)) return lower;
  return 'thing';
}

export function upsertEntity(
  db: RobinDb,
  type: string,
  canonicalName: string,
  profile?: string,
): EntityRow {
  const name = canonicalName.trim();
  type = normalizeEntityType(type);
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
      db.prepare(
        `UPDATE entities SET profile = ?, profile_generated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      ).run(profile, existing.id);
      return {
        ...existing,
        profile,
        profile_generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }
    return existing;
  }
  const info = db
    .prepare(
      profile != null
        ? `INSERT INTO entities (type, canonical_name, profile, profile_generated_at) VALUES (?, ?, ?, datetime('now'))`
        : `INSERT INTO entities (type, canonical_name, profile) VALUES (?, ?, ?)`,
    )
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

export function addRelation(
  db: RobinDb,
  subjectId: number,
  predicate: string,
  objectId: number,
  sourceEventId?: number,
): number {
  const normalized = predicate.trim().replace(/\s+/g, '_').toLowerCase();
  const info = db
    .prepare(`
    INSERT INTO relations (subject_id, predicate, object_id, ts, source_event_id)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(subjectId, normalized, objectId, new Date().toISOString(), sourceEventId ?? null);
  return Number(info.lastInsertRowid);
}

const PROFILE_STALE_DAYS = 30;

/**
 * Deterministic relation summary — the no-LLM fallback served when an entity
 * profile is stale (spec §C4). Pulls the 5 most recent relations and formats
 * them as human-readable lines. Returns null when the entity has no relations.
 */
function relationSummary(db: RobinDb, entityId: number, name: string): string | null {
  const rows = db
    .prepare(
      `SELECT r.predicate,
              CASE WHEN r.subject_id = ? THEN obj.canonical_name ELSE sub.canonical_name END AS other,
              CASE WHEN r.subject_id = ? THEN 'subject' ELSE 'object' END AS role
         FROM relations r
         JOIN entities sub ON sub.id = r.subject_id
         JOIN entities obj ON obj.id = r.object_id
        WHERE r.subject_id = ? OR r.object_id = ?
        ORDER BY r.ts DESC LIMIT 5`,
    )
    .all(entityId, entityId, entityId, entityId) as Array<{
    predicate: string;
    other: string;
    role: string;
  }>;
  if (rows.length === 0) return null;
  const lines = rows.map((o) =>
    o.role === 'subject'
      ? `${name} ${o.predicate} ${o.other}`
      : `${o.other} ${o.predicate} ${name}`,
  );
  return `recent relations: ${lines.join('; ')}`;
}

/**
 * Read-side staleness gate (spec §C4): a profile older than 30 days must not be
 * served as current truth. Stale (or unstamped) profiles are swapped for a
 * deterministic relation summary and marked `profile_stale` so consumers know the
 * synthesized text was withheld. Fresh profiles pass through untouched. NULL
 * profiles pass through untouched (nothing to replace).
 *
 * Timestamp comparison: `datetime(profile_generated_at) >= datetime(cutoff)` via
 * SQLite so sqlite-format stored values and ISO cutoff strings compare correctly
 * regardless of trailing 'Z' or 'T' separator differences (decision 8).
 */
export function withFreshProfile(
  db: RobinDb,
  row: EntityRow,
  now: () => Date = () => new Date(),
): EntityRow & { profile_stale?: boolean } {
  if (!row.profile) return row;
  const cutoff = new Date(now().getTime() - PROFILE_STALE_DAYS * 86_400_000).toISOString();
  const fresh =
    row.profile_generated_at !== null &&
    (
      db
        .prepare(`SELECT datetime(?) >= datetime(?) AS ok`)
        .get(row.profile_generated_at, cutoff) as { ok: number }
    ).ok === 1;
  if (fresh) return row;
  return { ...row, profile: relationSummary(db, row.id, row.canonical_name), profile_stale: true };
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
