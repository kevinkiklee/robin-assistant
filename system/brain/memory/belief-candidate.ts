import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { believe, normalizeTopic } from './belief.ts';
import type { RobinDb } from './db.ts';

/**
 * Render a Date in SQLite's `datetime('now')` format (`YYYY-MM-DD HH:MM:SS`,
 * UTC) so string comparisons against the `created_at`/`resolved_at` columns —
 * which default to `datetime('now')` — are apples-to-apples (an ISO `T…Z`
 * string sorts inconsistently against the space-separated SQLite form).
 */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Machine-drafted, unverified belief proposals. The biographer's second
 * extraction pass lands declarative claims here as `pending`; they are NEVER
 * written to the `belief.update` truth stream directly. Promotion is always an
 * explicit review action (`resolveBeliefCandidate`), which routes through the
 * existing `believe()` so supersession is inherited for free. Stale pending
 * candidates expire (→ `rejected`) so the queue cannot grow without bound.
 */
export interface BeliefCandidate {
  id: number;
  topic: string;
  claim: string;
  confidence: number | null;
  sourceEventId: number | null;
  status: 'pending' | 'promoted' | 'rejected';
  createdAt: string;
  resolvedAt: string | null;
}

interface RawRow {
  id: number;
  topic: string;
  claim: string;
  confidence: number | null;
  source_event_id: number | null;
  status: 'pending' | 'promoted' | 'rejected';
  created_at: string;
  resolved_at: string | null;
}

function mapRow(r: RawRow): BeliefCandidate {
  return {
    id: r.id,
    topic: r.topic,
    claim: r.claim,
    confidence: r.confidence,
    sourceEventId: r.source_event_id,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

/**
 * Insert a candidate belief. The topic is normalized to its canonical form.
 * Idempotent against duplicate pending proposals: if an identical pending
 * topic+claim already exists, the existing id is returned and no row is added
 * (keeps a chatty biographer from flooding the review queue with dupes).
 */
export function insertBeliefCandidate(
  db: RobinDb,
  input: {
    topic: string;
    claim: string;
    confidence?: number | null;
    sourceEventId?: number | null;
  },
): { id: number } {
  const topic = normalizeTopic(input.topic);
  if (!topic) throw new Error('insertBeliefCandidate: topic required');
  const claim = input.claim?.trim();
  if (!claim) throw new Error('insertBeliefCandidate: claim required');

  const existing = db
    .prepare(
      `SELECT id FROM belief_candidates
        WHERE status = 'pending' AND topic = ? AND claim = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(topic, claim) as { id: number } | undefined;
  if (existing) return { id: existing.id };

  const info = db
    .prepare(
      `INSERT INTO belief_candidates (topic, claim, confidence, source_event_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(topic, claim, input.confidence ?? null, input.sourceEventId ?? null);
  return { id: Number(info.lastInsertRowid) };
}

/** List candidates, newest-first, optionally filtered by status. */
export function listBeliefCandidates(
  db: RobinDb,
  opts: { status?: 'pending' | 'promoted' | 'rejected'; limit?: number } = {},
): BeliefCandidate[] {
  const limit = opts.limit ?? 50;
  const rows = opts.status
    ? (db
        .prepare(
          `SELECT * FROM belief_candidates WHERE status = ?
            ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(opts.status, limit) as RawRow[])
    : (db
        .prepare(`SELECT * FROM belief_candidates ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(limit) as RawRow[]);
  return rows.map(mapRow);
}

/**
 * Resolve a pending candidate. `promote` routes the claim through `believe()`
 * (inheriting supersession) and marks the candidate `promoted`, returning the
 * new belief event id. `reject` marks it `rejected` with no truth-stream write.
 * Resolving a non-pending (or missing) candidate is a no-op aside from the
 * `believe()` call being skipped.
 */
export function resolveBeliefCandidate(
  db: RobinDb,
  llm: LLMDispatcher | null,
  id: number,
  action: 'promote' | 'reject',
  reason?: string,
): { candidateId: number; action: 'promote' | 'reject'; promotedBeliefEventId: number | null } {
  void reason;
  const row = db.prepare(`SELECT * FROM belief_candidates WHERE id = ?`).get(id) as
    | RawRow
    | undefined;
  if (!row) throw new Error(`resolveBeliefCandidate: candidate ${id} not found`);
  if (row.status !== 'pending') {
    throw new Error(`resolveBeliefCandidate: candidate ${id} already ${row.status}`);
  }

  const now = sqliteUtc(new Date());

  if (action === 'reject') {
    db.prepare(
      `UPDATE belief_candidates SET status = 'rejected', resolved_at = ? WHERE id = ?`,
    ).run(now, id);
    return { candidateId: id, action, promotedBeliefEventId: null };
  }

  const res = believe(db, llm, {
    topic: row.topic,
    claim: row.claim,
    confidence: row.confidence ?? undefined,
  });
  db.prepare(`UPDATE belief_candidates SET status = 'promoted', resolved_at = ? WHERE id = ?`).run(
    now,
    id,
  );
  return { candidateId: id, action, promotedBeliefEventId: res.eventId };
}

/** Count candidates still awaiting review. */
export function countPendingCandidates(db: RobinDb): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS c FROM belief_candidates WHERE status = 'pending'`)
    .get() as { c: number };
  return r.c;
}

/**
 * Expire pending candidates whose `created_at` predates the cutoff (default 14
 * days), setting them to `rejected` with a `resolved_at`. Returns the number
 * expired. `now` is injectable for deterministic tests.
 */
export function expireStaleCandidates(
  db: RobinDb,
  olderThanDays = 14,
  now: Date = new Date(),
): number {
  const cutoff = sqliteUtc(new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000));
  const info = db
    .prepare(
      `UPDATE belief_candidates SET status = 'rejected', resolved_at = ?
        WHERE status = 'pending' AND created_at < ?`,
    )
    .run(sqliteUtc(now), cutoff);
  return info.changes;
}
