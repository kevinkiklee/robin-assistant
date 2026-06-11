import type { RobinDb } from '../../brain/memory/db.ts';

export type AlertSeverity = 'info' | 'warning' | 'critical';
const RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

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
  const open = db
    .prepare(`SELECT * FROM alerts WHERE source=? AND key=? AND resolved_at IS NULL`)
    .get(input.source, input.key) as AlertRow | undefined;
  if (!open) {
    const r = db
      .prepare(
        `INSERT INTO alerts (severity, source, key, message, context_json) VALUES (?,?,?,?,?)`,
      )
      .run(
        input.severity,
        input.source,
        input.key,
        input.message,
        input.context ? JSON.stringify(input.context) : null,
      );
    return db.prepare(`SELECT * FROM alerts WHERE id=?`).get(r.lastInsertRowid) as AlertRow;
  }
  const severity = RANK[input.severity] > RANK[open.severity] ? input.severity : open.severity;
  db.prepare(
    `UPDATE alerts SET severity=?, message=?, context_json=COALESCE(?, context_json),
       last_seen_at=datetime('now'), fire_count=fire_count+1 WHERE id=?`,
  ).run(severity, input.message, input.context ? JSON.stringify(input.context) : null, open.id);
  return db.prepare(`SELECT * FROM alerts WHERE id=?`).get(open.id) as AlertRow;
}

export function resolveAlert(db: RobinDb, source: string, key: string): void {
  db.prepare(
    `UPDATE alerts SET resolved_at=datetime('now') WHERE source=? AND key=? AND resolved_at IS NULL`,
  ).run(source, key);
}

export function ackAlert(db: RobinDb, id: number): boolean {
  return (
    db
      .prepare(`UPDATE alerts SET acked_at=datetime('now') WHERE id=? AND resolved_at IS NULL`)
      .run(id).changes > 0
  );
}

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
