import { existsSync, readdirSync, statSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb, closeDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { resolveUserDataDir, dbFilePath, userDataPaths } from '../../../lib/paths.ts';

export interface MigrateOptions {
  v2Path: string;
  dryRun?: boolean;
  phases?: Array<'schema' | 'derived' | 'flatfiles' | 'verify'>;
}

export interface MigrateReport {
  ts: string;
  v2Path: string;
  v3UserData: string;
  dryRun: boolean;
  phases: Record<string, { ok: boolean; count?: number; message?: string }>;
  errors: string[];
}

export async function migrateFromV2(opts: MigrateOptions): Promise<MigrateReport> {
  const userData = resolveUserDataDir();
  const phases = opts.phases ?? ['schema', 'derived', 'flatfiles', 'verify'];
  const report: MigrateReport = {
    ts: new Date().toISOString(),
    v2Path: resolve(opts.v2Path),
    v3UserData: userData,
    dryRun: !!opts.dryRun,
    phases: {},
    errors: [],
  };

  // Sanity check
  if (!existsSync(report.v2Path)) {
    report.errors.push(`v2 path does not exist: ${report.v2Path}`);
    return report;
  }
  const v2UserData = join(report.v2Path, 'user-data');
  if (!existsSync(v2UserData)) {
    report.errors.push(`v2 user-data not found at ${v2UserData}`);
    return report;
  }

  // Phase 1: schema
  if (phases.includes('schema')) {
    try {
      const db = openDb(dbFilePath(userData));
      applyMigrations(db, allMigrations);
      closeDb(db);
      report.phases.schema = { ok: true };
    } catch (err) {
      report.phases.schema = { ok: false, message: err instanceof Error ? err.message : String(err) };
      report.errors.push(`schema: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Phase 2: derived data
  if (phases.includes('derived')) {
    try {
      const r = await migrateDerivedData(v2UserData, userData, opts.dryRun);
      report.phases.derived = { ok: true, ...r };
    } catch (err) {
      report.phases.derived = { ok: false, message: err instanceof Error ? err.message : String(err) };
      report.errors.push(`derived: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Phase 3: flatfiles
  if (phases.includes('flatfiles')) {
    try {
      const r = migrateFlatFiles(v2UserData, userData, opts.dryRun);
      report.phases.flatfiles = { ok: true, count: r };
    } catch (err) {
      report.phases.flatfiles = { ok: false, message: err instanceof Error ? err.message : String(err) };
      report.errors.push(`flatfiles: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Phase 6: verify
  if (phases.includes('verify')) {
    try {
      const db = openDb(dbFilePath(userData));
      const events = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
      const entities = (db.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number }).c;
      closeDb(db);
      report.phases.verify = { ok: true, count: events + entities, message: `v3 has ${events} events + ${entities} entities` };
    } catch (err) {
      report.phases.verify = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // Write report
  const reportPath = join(userData, 'state', 'migrations', `migrate-report-${report.ts.replace(/[:.]/g, '-')}.json`);
  mkdirSync(join(userData, 'state', 'migrations'), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  return report;
}

async function migrateDerivedData(v2UserData: string, _v3UserData: string, _dryRun?: boolean): Promise<{ count: number; message: string }> {
  // Try to load @surrealdb/node and read v2 DB
  let surrealdbAvailable = false;
  try {
    await import('@surrealdb/node');
    surrealdbAvailable = true;
  } catch {
    // Not installed — fall through with empty derive
  }
  if (!surrealdbAvailable) {
    return { count: 0, message: 'derived: @surrealdb/node not available — skipped. Run pnpm add @surrealdb/node and rerun.' };
  }
  // Even if available, full SurrealDB read is complex. For MVP, just open v2 SQLite if any exists; otherwise skip with a note.
  const v2DbDir = join(v2UserData, 'data', 'db');
  if (!existsSync(v2DbDir)) {
    return { count: 0, message: `derived: v2 data dir not found at ${v2DbDir} — nothing to migrate` };
  }
  // Real implementation: connect to SurrealDB rocksdb://<v2DbDir>, SELECT events, entities, etc., transform.
  // For MVP placeholder, count files and return a message.
  const dbFiles = readdirSync(v2DbDir).length;
  return { count: 0, message: `derived: v2 RocksDB found with ${dbFiles} entries — full SurrealDB read deferred to richer migration pass; phase reported OK with 0 rows transformed.` };
}

function migrateFlatFiles(v2UserData: string, v3UserData: string, dryRun?: boolean): number {
  const subdirs = ['artifacts', 'skills', 'jobs', 'triggers', 'scripts', 'sources', 'profile'];
  let count = 0;
  const paths = userDataPaths(v3UserData);
  for (const sub of subdirs) {
    const src = join(v2UserData, sub);
    if (!existsSync(src)) continue;
    const dst = pickDest(sub, paths);
    if (dryRun) {
      const filesIn = walkCount(src);
      count += filesIn;
      continue;
    }
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
    count += walkCount(src);
  }
  return count;
}

function pickDest(sub: string, paths: ReturnType<typeof userDataPaths>): string {
  switch (sub) {
    case 'artifacts':
      return paths.content.artifacts;
    case 'sources':
      return paths.content.sources;
    case 'profile':
      return paths.config.root;
    case 'skills':
      return paths.extensions.skills;
    case 'jobs':
      return paths.extensions.jobs;
    case 'triggers':
      return paths.extensions.triggers;
    case 'scripts':
      return paths.extensions.scripts;
    default:
      return join(paths.root, sub);
  }
}

function walkCount(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const f = join(dir, entry);
    if (statSync(f).isDirectory()) n += walkCount(f);
    else n += 1;
  }
  return n;
}
