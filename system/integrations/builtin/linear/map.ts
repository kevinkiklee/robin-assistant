import type { RobinDb } from '../../../brain/memory/db.ts';

export interface MapRow {
  robin_ref: string;
  linear_issue_id: string;
  identifier: string | null;
  team_id: string | null;
  last_state_type: string | null;
  commented_refs: string;
  source_event_id: number | null;
  created_at: string;
  last_action_at: string;
  last_action: string | null;
}

export function lookupByRef(db: RobinDb, robinRef: string): MapRow | null {
  return (
    (db.prepare('SELECT * FROM linear_issue_map WHERE robin_ref = ?').get(robinRef) as
      | MapRow
      | undefined) ?? null
  );
}

export function lookupByIssueId(db: RobinDb, linearIssueId: string): MapRow | null {
  return (
    (db.prepare('SELECT * FROM linear_issue_map WHERE linear_issue_id = ?').get(linearIssueId) as
      | MapRow
      | undefined) ?? null
  );
}

export function upsertMap(
  db: RobinDb,
  row: {
    robin_ref: string;
    linear_issue_id: string;
    identifier?: string;
    team_id?: string;
    last_state_type?: string;
    source_event_id?: number;
    last_action: string;
  },
): void {
  db.prepare(`
    INSERT INTO linear_issue_map (robin_ref, linear_issue_id, identifier, team_id, last_state_type, source_event_id, last_action, last_action_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(robin_ref) DO UPDATE SET
      linear_issue_id = excluded.linear_issue_id,
      identifier = COALESCE(excluded.identifier, linear_issue_map.identifier),
      team_id = COALESCE(excluded.team_id, linear_issue_map.team_id),
      last_state_type = COALESCE(excluded.last_state_type, linear_issue_map.last_state_type),
      source_event_id = COALESCE(excluded.source_event_id, linear_issue_map.source_event_id),
      last_action = excluded.last_action,
      last_action_at = datetime('now')
  `).run(
    row.robin_ref,
    row.linear_issue_id,
    row.identifier ?? null,
    row.team_id ?? null,
    row.last_state_type ?? null,
    row.source_event_id ?? null,
    row.last_action,
  );
}

export function addCommentedRef(db: RobinDb, robinRef: string, commentRef: string): boolean {
  const row = lookupByRef(db, robinRef);
  if (!row) return false;
  const refs: string[] = JSON.parse(row.commented_refs);
  if (refs.includes(commentRef)) return false;
  refs.push(commentRef);
  db.prepare(
    "UPDATE linear_issue_map SET commented_refs = ?, last_action = ?, last_action_at = datetime('now') WHERE robin_ref = ?",
  ).run(JSON.stringify(refs), 'comment', robinRef);
  return true;
}

export function hasCommentedRef(db: RobinDb, robinRef: string, commentRef: string): boolean {
  const row = lookupByRef(db, robinRef);
  if (!row) return false;
  const refs: string[] = JSON.parse(row.commented_refs);
  return refs.includes(commentRef);
}

export function refreshStateTypes(
  db: RobinDb,
  updates: Array<{ linear_issue_id: string; state_type: string }>,
): void {
  const stmt = db.prepare(
    'UPDATE linear_issue_map SET last_state_type = ? WHERE linear_issue_id = ?',
  );
  const txn = db.transaction((rows: typeof updates) => {
    for (const { linear_issue_id, state_type } of rows) {
      stmt.run(state_type, linear_issue_id);
    }
  });
  txn(updates);
}

export function openMappedIssueIds(db: RobinDb): string[] {
  const rows = db
    .prepare(
      "SELECT linear_issue_id FROM linear_issue_map WHERE last_state_type IS NULL OR last_state_type NOT IN ('completed', 'cancelled')",
    )
    .all() as Array<{ linear_issue_id: string }>;
  return rows.map((r) => r.linear_issue_id);
}

export function isSatisfied(db: RobinDb, robinRef: string): boolean {
  const row = lookupByRef(db, robinRef);
  if (!row) return false;
  return row.last_state_type === 'completed' || row.last_state_type === 'cancelled';
}
