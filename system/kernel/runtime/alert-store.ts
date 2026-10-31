import type { RobinDb } from '../../brain/memory/db.ts';

export type AlertSeverity = 'info' | 'warning' | 'critical';
const RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

const OBSERVATION_SAMPLE_AT = new Set([1, 10, 100, 1000, 10000]);
const MAX_OBSERVATIONS = 8;

type Observation =
  | { n: number; at: string; message: string }
  | { deferred: string; at: string; message: string };

function parseContext(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function pushObservation(ctx: Record<string, unknown>, obs: Observation): void {
  const list = Array.isArray(ctx._observations) ? (ctx._observations as Observation[]) : [];
  list.push(obs);
  ctx._observations = list.slice(-MAX_OBSERVATIONS);
}

export interface AlertRow {
  id: number;
  severity: AlertSeverity;
  source: string;
  key: string;
  message: string;
  context_json: string | null;
  first_seen_at: string;
  last_seen_at: string;
  fire_count: number;
  resolved_at: string | null;
  acked_at: string | null;
  /** Incident ladder (spec B, migration 036): set once a repair has been attempted
   *  for this open incident — the once-per-incident guard IS this column's atomicity. */
  repair_attempted_at: string | null;
  /** Set once this open incident has been escalated (only after a repair attempt). */
  escalated_at: string | null;
  /** 'repaired' | 'needs-human' | null (still in flight). Set by `setOutcome` or
   *  credited automatically by `resolveAlert` when a repair preceded the resolve. */
  outcome: string | null;
}

export interface RecordAlertInput {
  severity: AlertSeverity;
  source: string;
  key: string;
  message: string;
  context?: Record<string, unknown>;
}

/** Open or refresh the single open alert for (source,key). */
export function recordAlert(db: RobinDb, input: RecordAlertInput): AlertRow {
  const selectOpen = () =>
    db
      .prepare(`SELECT * FROM alerts WHERE source=? AND key=? AND resolved_at IS NULL`)
      .get(input.source, input.key) as AlertRow | undefined;

  const refresh = (open: AlertRow): AlertRow => {
    const severity = RANK[input.severity] > RANK[open.severity] ? input.severity : open.severity;
    const nextCount = open.fire_count + 1;
    const ctx = { ...parseContext(open.context_json), ...(input.context ?? {}) };
    if (OBSERVATION_SAMPLE_AT.has(nextCount)) {
      pushObservation(ctx, { n: nextCount, at: new Date().toISOString(), message: input.message });
    }
    db.prepare(
      `UPDATE alerts SET severity=?, message=?, context_json=?,
         last_seen_at=datetime('now'), fire_count=fire_count+1 WHERE id=?`,
    ).run(severity, input.message, JSON.stringify(ctx), open.id);
    return db.prepare(`SELECT * FROM alerts WHERE id=?`).get(open.id) as AlertRow;
  };

  const open = selectOpen();
  if (open) return refresh(open);

  try {
    const ctx = { ...(input.context ?? {}) };
    pushObservation(ctx, { n: 1, at: new Date().toISOString(), message: input.message });
    const r = db
      .prepare(
        `INSERT INTO alerts (severity, source, key, message, context_json) VALUES (?,?,?,?,?)`,
      )
      .run(input.severity, input.source, input.key, input.message, JSON.stringify(ctx));
    return db.prepare(`SELECT * FROM alerts WHERE id=?`).get(r.lastInsertRowid) as AlertRow;
  } catch (err) {
    // Lost the insert race to another process — the open row now exists; refresh it.
    const winner = selectOpen();
    if (winner) return refresh(winner);
    throw err; // genuinely unexpected
  }
}

/** Record a deferred-child note on the open (source,key) alert's observations.
 *  A repeat call for the same `childName` REPLACES that entry in place (bumping
 *  its `at`/`message`) instead of appending a new one — otherwise a chatty
 *  deferring child would, one MAX_OBSERVATIONS-sized batch at a time, evict the
 *  parent's own sampled `n:1/n:10/...` history. Distinct children still get
 *  distinct entries. Returns false when no open row exists. Never throws
 *  (monitor-tick safe). */
export function recordDeferredObservation(
  db: RobinDb,
  source: string,
  key: string,
  childName: string,
  message: string,
): boolean {
  try {
    const open = db
      .prepare(`SELECT * FROM alerts WHERE source=? AND key=? AND resolved_at IS NULL`)
      .get(source, key) as AlertRow | undefined;
    if (!open) return false;
    const ctx = parseContext(open.context_json);
    const list = Array.isArray(ctx._observations) ? (ctx._observations as Observation[]) : [];
    const existing = list.find((o) => 'deferred' in o && o.deferred === childName);
    if (existing) {
      existing.at = new Date().toISOString();
      existing.message = message;
      ctx._observations = list;
    } else {
      pushObservation(ctx, { deferred: childName, at: new Date().toISOString(), message });
    }
    db.prepare(`UPDATE alerts SET context_json=?, last_seen_at=datetime('now') WHERE id=?`).run(
      JSON.stringify(ctx),
      open.id,
    );
    return true;
  } catch {
    return false;
  }
}

/** Resolve the open (source,key) incident. If a repair was attempted on it and
 *  no outcome was recorded yet, credit it 'repaired' in the same UPDATE — the
 *  check went green after a repair attempt. */
export function resolveAlert(db: RobinDb, source: string, key: string): void {
  db.prepare(
    `UPDATE alerts SET resolved_at=datetime('now'),
        outcome=CASE WHEN repair_attempted_at IS NOT NULL AND outcome IS NULL
                     THEN 'repaired' ELSE outcome END
      WHERE source=? AND key=? AND resolved_at IS NULL`,
  ).run(source, key);
}

/** Incident ladder (spec B): claim the one repair attempt for the OPEN
 *  (source,key) incident. The UPDATE's WHERE clause (resolved_at IS NULL AND
 *  repair_attempted_at IS NULL) IS the once-per-incident guard — no in-memory
 *  state is load-bearing here, so a daemon restart mid-incident cannot
 *  double-fire the repair. Returns whether THIS call won the claim. */
export function markRepairAttempted(db: RobinDb, source: string, key: string): boolean {
  return (
    db
      .prepare(
        `UPDATE alerts SET repair_attempted_at=datetime('now')
          WHERE source=? AND key=? AND resolved_at IS NULL AND repair_attempted_at IS NULL`,
      )
      .run(source, key).changes > 0
  );
}

/** Claim the one escalation for the OPEN (source,key) incident. Requires a prior
 *  repair attempt (an incident is only escalated after its repair has already
 *  been tried) and fires at most once, same atomic-UPDATE guard as
 *  `markRepairAttempted`. Returns whether THIS call won the claim. */
export function markEscalated(db: RobinDb, source: string, key: string): boolean {
  return (
    db
      .prepare(
        `UPDATE alerts SET escalated_at=datetime('now')
          WHERE source=? AND key=? AND resolved_at IS NULL
            AND repair_attempted_at IS NOT NULL AND escalated_at IS NULL`,
      )
      .run(source, key).changes > 0
  );
}

/** Stamp the terminal outcome ('repaired' | 'needs-human') on the OPEN
 *  (source,key) incident. Idempotent — a later call simply overwrites. */
export function setOutcome(
  db: RobinDb,
  source: string,
  key: string,
  outcome: 'repaired' | 'needs-human',
): void {
  db.prepare(`UPDATE alerts SET outcome=? WHERE source=? AND key=? AND resolved_at IS NULL`).run(
    outcome,
    source,
    key,
  );
}

/** Read the OPEN (source,key) alert row, or undefined if none is open. */
export function getOpenAlert(db: RobinDb, source: string, key: string): AlertRow | undefined {
  return db
    .prepare(`SELECT * FROM alerts WHERE source=? AND key=? AND resolved_at IS NULL`)
    .get(source, key) as AlertRow | undefined;
}

export function ackAlert(db: RobinDb, id: number): boolean {
  return (
    db
      .prepare(`UPDATE alerts SET acked_at=datetime('now') WHERE id=? AND resolved_at IS NULL`)
      .run(id).changes > 0
  );
}

/** all: include resolved history (implies includeAcked). includeAcked: also show acked-but-open rows in the default open-only view. */
export function listAlerts(
  db: RobinDb,
  opts: { all?: boolean; includeAcked?: boolean },
): AlertRow[] {
  if (opts.all)
    return db.prepare(`SELECT * FROM alerts ORDER BY last_seen_at DESC`).all() as AlertRow[];
  const ackClause = opts.includeAcked ? '' : 'AND acked_at IS NULL';
  return db
    .prepare(
      `SELECT * FROM alerts WHERE resolved_at IS NULL ${ackClause} ORDER BY last_seen_at DESC`,
    )
    .all() as AlertRow[];
}

export function pruneResolvedAlerts(db: RobinDb, retentionDays: number): number {
  return db
    .prepare(
      `DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < datetime('now', ?)`,
    )
    .run(`-${retentionDays} days`).changes;
}
