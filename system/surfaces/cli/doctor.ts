import { resolve as resolvePath } from 'node:path';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import {
  dbReachableInvariant,
  dbSchemaCurrentInvariant,
  dbWalSizeBoundedInvariant,
  userDataWritableInvariant,
} from '../../kernel/invariants/builtins/index.ts';
import { runInvariants } from '../../kernel/invariants/runner.ts';
import type { InvariantReport } from '../../kernel/invariants/types.ts';
import { writeRunbook } from '../../kernel/invariants/runbook.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

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
  }>;
  summary: { ok: number; warn: number; fail: number; exit_code: 0 | 1 | 2 };
}

export async function runDoctor(opts: { version: string }): Promise<DoctorReport> {
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
      summary: { ok: 0, warn: 0, fail: 1, exit_code: 2 },
    };
  }

  const reports = await runInvariants([
    userDataWritableInvariant(userData),
    dbReachableInvariant(db),
    dbSchemaCurrentInvariant(db),
    dbWalSizeBoundedInvariant(db),
  ]);

  closeDb(db);

  const checks = reports.map((r: InvariantReport) => ({
    name: r.name,
    status: r.ok ? ('ok' as const) : ('fail' as const),
    severity: r.severity,
    message: r.message,
    remediation: r.remediation,
    duration_ms: r.duration_ms,
  }));

  const summary = checks.reduce(
    (acc, c) => {
      if (c.status === 'ok') acc.ok++;
      else if (c.severity === 'critical') acc.fail++;
      else acc.warn++;
      return acc;
    },
    { ok: 0, warn: 0, fail: 0 } as { ok: number; warn: number; fail: number },
  );

  const exit_code = summary.fail > 0 ? 2 : summary.warn > 0 ? 1 : 0;

  return {
    robin_version: opts.version,
    node_version: process.version,
    user_data_dir: userData,
    checks,
    summary: { ...summary, exit_code },
  };
}

export function printDoctorHuman(report: DoctorReport): void {
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`Robin Doctor — robin v${report.robin_version} on Node ${report.node_version}`);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`User data: ${report.user_data_dir}`);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('');
  for (const c of report.checks) {
    const icon = c.status === 'ok' ? '✓' : c.severity === 'critical' ? '✗' : '⚠';
    let line = `${icon} ${c.name}`;
    if (c.message) line += ` — ${c.message}`;
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log(line);
    // biome-ignore lint/suspicious/noConsole: CLI output
    if (c.remediation && c.status === 'fail') console.log(`    → ${c.remediation}`);
  }
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('');
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(
    `Summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail`,
  );
}

export function emitRunbook(opts: { write: boolean; path?: string }): { path: string; existed: boolean } {
  const userData = resolveUserDataDir();
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  const invariants = [
    userDataWritableInvariant(userData),
    dbReachableInvariant(db),
    dbSchemaCurrentInvariant(db),
    dbWalSizeBoundedInvariant(db),
  ];
  const path = opts.path ?? resolvePath(process.cwd(), 'RUNBOOK.md');
  if (opts.write) {
    const r = writeRunbook(path, invariants);
    closeDb(db);
    return { path, existed: r.existed };
  }
  closeDb(db);
  return { path, existed: false };
}
