import type { RobinDb } from '../../memory/db.ts';
import type { PersonalDomain } from '../../memory/domains.ts';
import type { Habit, HabitStatus, PatternKind } from './types.ts';

/**
 * Behavioral Habit Inference (Phase 2) — the `habits` store (CRUD + the engine ops).
 * Design ref: docs/design/2026-06-17-behavioral-habit-inference-design.md §4–§8.
 *
 * Mirrors belief-candidate.ts: prepared statements built per-call, Float32Array-as-blob
 * embeddings, and the same conservative cosine helper for semantic dedup/suppression.
 */

/**
 * Render a Date in SQLite's `datetime('now')` format (`YYYY-MM-DD HH:MM:SS`, UTC) so
 * string comparisons against the timestamp columns are apples-to-apples (an ISO `T…Z`
 * string sorts inconsistently against the space-separated SQLite form).
 */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function vecToBlob(vec: number[] | Float32Array): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

function blobToVec(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/** Cosine similarity over two equal-length vectors; 0 when either is a zero vector. */
function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface RawRow {
  id: number;
  statement: string;
  domain: string;
  pattern_kind: string;
  confidence: number;
  support_count: number;
  support_streams: number;
  contradiction_count: number;
  evidence_event_ids: string;
  evidence_summary: string;
  embedding: Buffer | null;
  first_seen: string;
  last_seen: string;
  last_reinforced: string;
  status: string;
  graduated_belief_id: number | null;
  created_at: string;
  updated_at: string;
}

function parseEventIds(json: string): number[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

function mapRow(r: RawRow): Habit {
  return {
    id: r.id,
    statement: r.statement,
    domain: r.domain as PersonalDomain,
    patternKind: r.pattern_kind as PatternKind,
    confidence: r.confidence,
    supportCount: r.support_count,
    supportStreams: r.support_streams,
    contradictionCount: r.contradiction_count,
    evidenceEventIds: parseEventIds(r.evidence_event_ids),
    evidenceSummary: r.evidence_summary,
    embedding: r.embedding ? blobToVec(r.embedding) : null,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    lastReinforced: r.last_reinforced,
    status: r.status as HabitStatus,
    graduatedBeliefId: r.graduated_belief_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface InsertHabitInput {
  statement: string;
  domain: PersonalDomain;
  patternKind: PatternKind;
  confidence?: number;
  supportCount?: number;
  supportStreams?: number;
  contradictionCount?: number;
  evidenceEventIds?: number[];
  evidenceSummary?: string;
  embedding?: number[] | Float32Array | null;
  firstSeen?: Date | string;
  lastSeen?: Date | string;
  lastReinforced?: Date | string;
  status?: HabitStatus;
  graduatedBeliefId?: number | null;
}

function tsArg(t: Date | string | undefined, fallback: string): string {
  if (t == null) return fallback;
  return t instanceof Date ? sqliteUtc(t) : t;
}

/**
 * Insert a new habit. Observation-window timestamps default to `now` when omitted.
 * Returns the new id. The creation floor (§7) is enforced by the engine BEFORE calling
 * this — the store is a faithful writer, not a policy gate.
 */
export function insertHabit(db: RobinDb, input: InsertHabitInput): { id: number } {
  const statement = input.statement?.trim();
  if (!statement) throw new Error('insertHabit: statement required');
  const now = sqliteUtc(new Date());
  const info = db
    .prepare(
      `INSERT INTO habits (
         statement, domain, pattern_kind, confidence, support_count, support_streams,
         contradiction_count, evidence_event_ids, evidence_summary, embedding,
         first_seen, last_seen, last_reinforced, status, graduated_belief_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      statement,
      input.domain,
      input.patternKind,
      input.confidence ?? 0,
      input.supportCount ?? 0,
      input.supportStreams ?? 0,
      input.contradictionCount ?? 0,
      JSON.stringify(input.evidenceEventIds ?? []),
      input.evidenceSummary ?? '',
      input.embedding ? vecToBlob(input.embedding) : null,
      tsArg(input.firstSeen, now),
      tsArg(input.lastSeen, now),
      tsArg(input.lastReinforced, now),
      input.status ?? 'soft',
      input.graduatedBeliefId ?? null,
    );
  return { id: Number(info.lastInsertRowid) };
}

/** Fetch one habit by id, or null. */
export function getHabit(db: RobinDb, id: number): Habit | null {
  const row = db.prepare(`SELECT * FROM habits WHERE id = ?`).get(id) as RawRow | undefined;
  return row ? mapRow(row) : null;
}

/** List habits, optionally filtered by status, newest-reinforced first. */
export function listHabits(db: RobinDb, status?: HabitStatus): Habit[] {
  const rows = status
    ? (db
        .prepare(`SELECT * FROM habits WHERE status = ? ORDER BY last_reinforced DESC, id DESC`)
        .all(status) as RawRow[])
    : (db.prepare(`SELECT * FROM habits ORDER BY last_reinforced DESC, id DESC`).all() as RawRow[]);
  return rows.map(mapRow);
}

/**
 * Tier A exact-entity reinforcement (§5.A.3): bump `support_count` and refresh
 * `last_reinforced` / `last_seen` for a habit that a new signal corroborates. Optional
 * `addEventId` appends to the evidence id-array and `supportStreams` records a fresh
 * distinct-stream count when the reinforcement came from a new stream. Confidence is
 * NOT touched here — it is recomputed from state by `recomputeConfidenceFor`.
 */
export function updateHabitReinforcement(
  db: RobinDb,
  id: number,
  opts: { addEventId?: number; supportStreams?: number; at?: Date | string } = {},
): void {
  const at = tsArg(opts.at, sqliteUtc(new Date()));
  const habit = getHabit(db, id);
  if (!habit) throw new Error(`updateHabitReinforcement: habit ${id} not found`);

  const eventIds = habit.evidenceEventIds.slice();
  if (opts.addEventId != null && !eventIds.includes(opts.addEventId)) {
    eventIds.push(opts.addEventId);
  }
  const supportStreams = opts.supportStreams ?? habit.supportStreams;

  db.prepare(
    `UPDATE habits
        SET support_count = support_count + 1,
            support_streams = ?,
            evidence_event_ids = ?,
            last_reinforced = ?,
            last_seen = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(supportStreams, JSON.stringify(eventIds), at, at, id);
}

/**
 * Set a habit's lifecycle status. On graduation the caller passes the spawned
 * `preferences` belief_candidate id via `graduatedBeliefId` so `graduated_belief_id`
 * is wired in the same write.
 */
export function setHabitStatus(
  db: RobinDb,
  id: number,
  status: HabitStatus,
  graduatedBeliefId?: number | null,
): void {
  if (graduatedBeliefId !== undefined) {
    db.prepare(
      `UPDATE habits SET status = ?, graduated_belief_id = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(status, graduatedBeliefId, id);
  } else {
    db.prepare(`UPDATE habits SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
      status,
      id,
    );
  }
}

/** Persist a freshly-computed confidence (Tier A recompute, §6). */
export function recomputeConfidenceFor(db: RobinDb, id: number, confidence: number): void {
  const clamped = Math.min(1, Math.max(0, confidence));
  db.prepare(`UPDATE habits SET confidence = ?, updated_at = datetime('now') WHERE id = ?`).run(
    clamped,
    id,
  );
}

/**
 * Find the most semantically-similar existing habit to `embedding`, for dedup/upsert.
 * Compares against every habit's stored embedding (skipping rows without one) and
 * returns the best match at/above `threshold`, or null. Optional `statuses` restricts
 * the comparison set (e.g. only `soft`/`graduated` when proposing a new habit). Cosine
 * threshold defaults conservative (0.92) to match belief-candidate dedup.
 */
export function findNearestHabitByEmbedding(
  db: RobinDb,
  embedding: number[] | Float32Array,
  opts: { threshold?: number; statuses?: HabitStatus[] } = {},
): { habit: Habit; similarity: number } | null {
  const threshold = opts.threshold ?? 0.92;
  const q = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);

  const rows = (
    opts.statuses && opts.statuses.length > 0
      ? (db
          .prepare(
            `SELECT * FROM habits
              WHERE embedding IS NOT NULL
                AND status IN (${opts.statuses.map(() => '?').join(', ')})`,
          )
          .all(...opts.statuses) as RawRow[])
      : (db.prepare(`SELECT * FROM habits WHERE embedding IS NOT NULL`).all() as RawRow[])
  ).filter((r) => r.embedding);

  let best: { habit: Habit; similarity: number } | null = null;
  for (const r of rows) {
    const sim = cosine(q, blobToVec(r.embedding as Buffer));
    if (sim >= threshold && (best === null || sim > best.similarity)) {
      best = { habit: mapRow(r), similarity: sim };
    }
  }
  return best;
}

/**
 * Return every retired habit's embedding (for engine-enforced suppression, §8): a
 * proposed habit is embedding-matched against this set and dropped on collision so a
 * vetoed/retired pattern can never resurrect. Rows without an embedding are skipped.
 */
export function listRetiredEmbeddings(db: RobinDb): Array<{ id: number; embedding: Float32Array }> {
  const rows = db
    .prepare(`SELECT id, embedding FROM habits WHERE status = 'retired' AND embedding IS NOT NULL`)
    .all() as Array<{ id: number; embedding: Buffer }>;
  return rows.map((r) => ({ id: r.id, embedding: blobToVec(r.embedding) }));
}
