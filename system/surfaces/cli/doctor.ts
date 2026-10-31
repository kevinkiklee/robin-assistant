import { resolve as resolvePath } from 'node:path';
import type { RobinDb } from '../../brain/memory/db.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { buildDoctorInvariants } from '../../kernel/invariants/doctor-set.ts';
import { writeRunbook } from '../../kernel/invariants/runbook.ts';
import { runInvariants } from '../../kernel/invariants/runner.ts';
import type { InvariantReport } from '../../kernel/invariants/types.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export interface FreshnessRow {
  name: string;
  /** ISO timestamp of last successful tick, or null if never. */
  last_ok: string | null;
  /** Human-readable age string, e.g. '2h', '3d', or 'never'. */
  age: string;
  /** Present when consecutive_skips >= 3 — the skip reason. */
  skipping?: string;
}

export interface DoctorReport {
  robin_version: string;
  node_version: string;
  user_data_dir: string;
  checks: Array<{
    name: string;
    status: 'ok' | 'fail';
    severity: 'info' | 'warning' | 'critical';
    message?: string;
    remediation?: string;
    duration_ms: number;
    /** True when --fix ran a repair for this check; `status` is the post-repair re-check. */
    repaired?: boolean;
  }>;
  summary: { ok: number; warn: number; fail: number; repaired: number; exit_code: 0 | 1 | 2 };
  /** Per-integration freshness snapshot from integration_state. */
  freshness: FreshnessRow[];
}

/**
 * Humanize an age in milliseconds to a short string like '2h' or '3d'.
 * Returns 'never' for null/undefined/non-finite values.
 */
function humanizeAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'never';
  const h = ms / 3_600_000;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/** Query integration_state for the freshness snapshot. */
function queryFreshness(db: RobinDb): FreshnessRow[] {
  let rows: Array<{
    name: string;
    last_ok: string | null;
    skips: string | null;
    skip_reason: string | null;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT integration_name AS name,
                MAX(CASE WHEN key='last_ok_at' THEN value END) AS last_ok,
                MAX(CASE WHEN key='consecutive_skips' THEN value END) AS skips,
                MAX(CASE WHEN key='last_skip_reason' THEN value END) AS skip_reason
           FROM integration_state
          GROUP BY integration_name
          ORDER BY name`,
      )
      .all() as Array<{
      name: string;
      last_ok: string | null;
      skips: string | null;
      skip_reason: string | null;
    }>;
  } catch {
    // integration_state table may not exist on very old DBs; degrade gracefully.
    return [];
  }

  const now = Date.now();
  return rows.map((r) => {
    // last_ok_at is written as ISO 8601 with 'Z' by the daemon (Date.toISOString()),
    // but sqlite may strip the zone when storing. Append 'Z' only if no timezone
    // designator is already present, so Date.parse always treats the value as UTC.
    const lastOkStr = r.last_ok
      ? r.last_ok.endsWith('Z') || r.last_ok.includes('+')
        ? r.last_ok
        : `${r.last_ok}Z`
      : null;
    const ageMs = lastOkStr ? now - Date.parse(lastOkStr) : null;
    const age = humanizeAge(ageMs);
    const row: FreshnessRow = { name: r.name, last_ok: r.last_ok ?? null, age };
    if (Number(r.skips ?? '0') >= 3) {
      row.skipping = r.skip_reason ?? 'unknown reason';
    }
    return row;
  });
}

export async function runDoctor(opts: {
  version: string;
  /** Auto-repair failing checks that declare a safe `repair()`, then re-check. */
  fix?: boolean;
}): Promise<DoctorReport> {
  const userData = resolveUserDataDir();
  const dbPath = dbFilePath(userData);

  let db: ReturnType<typeof openDb>;
  try {
    db = openDb(dbPath);
    applyMigrations(db, allMigrations);
  } catch (err) {
    // If we can't even open the DB, the doctor reports that as the single failure.
    return {
      robin_version: opts.version,
      node_version: process.version,
      user_data_dir: userData,
      checks: [
        {
          name: 'db.openable',
          status: 'fail',
          severity: 'critical',
          message: err instanceof Error ? err.message : String(err),
          remediation: 'robin init',
          duration_ms: 0,
        },
      ],
      summary: { ok: 0, warn: 0, fail: 1, repaired: 0, exit_code: 2 },
      freshness: [],
    };
  }

  const [reports, freshness] = await Promise.all([
    runInvariants(buildDoctorInvariants(db, userData), { fix: opts.fix }),
    Promise.resolve(queryFreshness(db)),
  ]);

  closeDb(db);

  const checks = reports.map((r: InvariantReport) => ({
    name: r.name,
    status: r.ok ? ('ok' as const) : ('fail' as const),
    severity: r.severity,
    message: r.message,
    remediation: r.remediation,
    duration_ms: r.duration_ms,
    ...(r.repaired ? { repaired: true } : {}),
  }));

  const summary = checks.reduce(
    (acc, c) => {
      if (c.status === 'ok') acc.ok++;
      else if (c.severity === 'critical') acc.fail++;
      else acc.warn++;
      if (c.repaired) acc.repaired++;
      return acc;
    },
    { ok: 0, warn: 0, fail: 0, repaired: 0 } as {
      ok: number;
      warn: number;
      fail: number;
      repaired: number;
    },
  );

  const exit_code = summary.fail > 0 ? 2 : summary.warn > 0 ? 1 : 0;

  return {
    robin_version: opts.version,
    node_version: process.version,
    user_data_dir: userData,
    checks,
    summary: { ...summary, exit_code },
    freshness,
  };
}

export function printDoctorHuman(report: DoctorReport): void {
  console.log(`Robin Doctor — robin v${report.robin_version} on Node ${report.node_version}`);
  console.log(`User data: ${report.user_data_dir}`);
  console.log('');
  for (const c of report.checks) {
    const icon = c.status === 'ok' ? '✓' : c.severity === 'critical' ? '✗' : '⚠';
    let line = `${icon} ${c.name}`;
    if (c.message) line += ` — ${c.message}`;
    console.log(line);
    if (c.repaired) console.log(`    ↻ auto-repaired${c.status === 'ok' ? ' (now ok)' : ''}`);
    if (c.remediation && c.status === 'fail') console.log(`    → ${c.remediation}`);
  }
  console.log('');
  console.log(
    `Summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail` +
      (report.summary.repaired ? ` (${report.summary.repaired} auto-repaired)` : ''),
  );

  if (report.freshness.length > 0) {
    console.log('');
    console.log('Integration Freshness:');
    for (const row of report.freshness) {
      let line = `  ${row.name.padEnd(30)} last ok: ${row.age}`;
      if (row.skipping !== undefined) line += `  [skipping: ${row.skipping}]`;
      console.log(line);
    }
  }
}

export function emitRunbook(opts: { write: boolean; path?: string }): {
  path: string;
  existed: boolean;
} {
  const userData = resolveUserDataDir();
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  // Document the FULL doctor set, not a hand-picked subset — otherwise the runbook
  // silently omits invariants (it long listed only 4 of 11) and the operator docs
  // drift from what `robin doctor` actually checks. Same source as the CLI/daily run.
  const invariants = buildDoctorInvariants(db, userData);
  // Default to the committed canonical runbook (docs/RUNBOOK.md). The previous
  // cwd/RUNBOOK.md default wrote a stray repo-root file, leaving the real doc
  // stale — writeRunbook updates only between the sentinels, preserving the
  // curated preamble in docs/RUNBOOK.md.
  const path = opts.path ?? resolvePath(process.cwd(), 'docs', 'RUNBOOK.md');
  if (opts.write) {
    const r = writeRunbook(path, invariants);
    closeDb(db);
    return { path, existed: r.existed };
  }
  closeDb(db);
  return { path, existed: false };
}
