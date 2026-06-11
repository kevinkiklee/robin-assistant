import type { RobinDb } from '../../brain/memory/db.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export interface AgentMetricsRow {
  label: string;
  runs: number;
  costUsd: number;
  didWork: number;
  noOp: number;
  blocked: number;
  unparseable: number;
  verified: number;
  mismatches: number;
  lastDidWork: string | null;
}

/** Per-handler ROI rollup over the agent_usage ledger (spec §B5). */
export function agentMetricsRows(db: RobinDb): AgentMetricsRow[] {
  return db
    .prepare(
      `SELECT label,
              COUNT(*)                                                      AS runs,
              ROUND(COALESCE(SUM(cost_usd), 0), 4)                         AS costUsd,
              SUM(CASE WHEN outcome='did-work'     THEN 1 ELSE 0 END)      AS didWork,
              SUM(CASE WHEN outcome='no-op'        THEN 1 ELSE 0 END)      AS noOp,
              SUM(CASE WHEN outcome='blocked'      THEN 1 ELSE 0 END)      AS blocked,
              SUM(CASE WHEN outcome='unparseable'  THEN 1 ELSE 0 END)      AS unparseable,
              SUM(CASE WHEN verified='verified'         THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN verified='outcome-mismatch' THEN 1 ELSE 0 END) AS mismatches,
              MAX(CASE WHEN outcome='did-work' THEN ts END)                AS lastDidWork
         FROM agent_usage
        WHERE label IS NOT NULL AND surface LIKE 'agentic-%'
        GROUP BY label ORDER BY label`,
    )
    .all() as AgentMetricsRow[];
}

export function agentMetricsText(db: RobinDb): string {
  const rows = agentMetricsRows(db);
  if (rows.length === 0) return 'No labeled agent runs recorded yet.';
  const lines = rows.map(
    (r) =>
      `${r.label}  runs:${r.runs}  $${r.costUsd.toFixed(2)}  did-work:${r.didWork} (verified ${r.verified}, mismatch ${r.mismatches})  no-op:${r.noOp}  blocked:${r.blocked}  unparseable:${r.unparseable}  last did-work: ${r.lastDidWork ?? 'never'}`,
  );
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  return [
    ...lines,
    `total: ${rows.reduce((s, r) => s + r.runs, 0)} runs, $${totalCost.toFixed(2)}`,
  ].join('\n');
}

export async function runMetricsCommand(args: string[]): Promise<void> {
  if (!args.includes('--agents')) {
    console.error('usage: robin metrics --agents');
    process.exit(2);
  }
  const userData = resolveUserDataDir();
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  try {
    console.log(agentMetricsText(db));
  } finally {
    closeDb(db);
  }
}
