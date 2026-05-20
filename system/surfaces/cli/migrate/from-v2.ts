import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { dbFilePath, resolveUserDataDir, userDataPaths } from '../../../lib/paths.ts';

export interface MigrateOptions {
  v2Path: string;
  dryRun?: boolean;
  phases?: Array<'schema' | 'derived' | 'flatfiles' | 'verify'>;
}

export interface MigrateReport {
  ts: string;
  v2Path: string;
  targetUserData: string;
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
    targetUserData: userData,
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
      report.phases.schema = {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
      report.errors.push(`schema: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Phase 2: derived data
  if (phases.includes('derived')) {
    try {
      const r = await migrateDerivedData(v2UserData, userData, opts.dryRun);
      report.phases.derived = { ok: true, ...r };
    } catch (err) {
      report.phases.derived = {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
      report.errors.push(`derived: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Phase 3: flatfiles
  if (phases.includes('flatfiles')) {
    try {
      const r = migrateFlatFiles(v2UserData, userData, opts.dryRun);
      report.phases.flatfiles = { ok: true, count: r };
    } catch (err) {
      report.phases.flatfiles = {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
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
      report.phases.verify = {
        ok: true,
        count: events + entities,
        message: `target has ${events} events + ${entities} entities`,
      };
    } catch (err) {
      report.phases.verify = {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Write report
  const reportPath = join(
    userData,
    'state',
    'migrations',
    `migrate-report-${report.ts.replace(/[:.]/g, '-')}.json`,
  );
  mkdirSync(join(userData, 'state', 'migrations'), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  return report;
}

async function migrateDerivedData(
  v2UserData: string,
  targetUserData: string,
  dryRun?: boolean,
): Promise<{ count: number; message: string; tables?: Record<string, number> }> {
  const v2DbDir = join(v2UserData, 'data', 'db');
  if (!existsSync(v2DbDir)) {
    return { count: 0, message: `derived: v2 data dir not found at ${v2DbDir} — nothing to migrate` };
  }

  // Dynamically import surrealdb to avoid forcing the dep when not used
  let Surreal: any;
  let createNodeEngines: any;
  try {
    const surrealdb = await import('surrealdb');
    Surreal = surrealdb.Surreal;
    const surrealNode = await import('@surrealdb/node');
    createNodeEngines = surrealNode.createNodeEngines;
  } catch (err) {
    return { count: 0, message: `derived: SurrealDB client not available — ${err instanceof Error ? err.message : err}` };
  }

  let db: any; // dynamic import types are tricky, use any for runtime
  try {
    db = new Surreal({ engines: createNodeEngines() });
    await db.connect(`rocksdb://${v2DbDir}`);
    // v2's namespace + database names — make a best guess; if SurrealDB rejects, surface
    try {
      await db.use({ namespace: 'robin', database: 'main' });
    } catch {
      // some v2 installs may not have namespace; try without
    }
  } catch (err) {
    return { count: 0, message: `derived: failed to connect to v2 SurrealDB at ${v2DbDir} — ${err instanceof Error ? err.message : err}` };
  }

  // Open the target Robin SQLite for writes
  const targetDb = openDb(dbFilePath(targetUserData));
  applyMigrations(targetDb, allMigrations);

  const tables: Record<string, number> = {};
  const errors: string[] = [];

  try {
    // Discover tables
    let dbTables: string[] = [];
    try {
      const info = await db.query('INFO FOR DB');
      const tb = info?.[0]?.tb ?? {};
      dbTables = Object.keys(tb);
    } catch (err) {
      errors.push(`could not enumerate tables: ${err instanceof Error ? err.message : err}`);
    }

    const wanted = ['event', 'entity', 'relation', 'prediction', 'correction'];
    for (const t of wanted) {
      if (dbTables.length > 0 && !dbTables.includes(t)) continue; // skip if we know it doesn't exist
      try {
        const rows = await db.query(`SELECT * FROM ${t} LIMIT 5000`);
        const data = (rows?.[0] ?? []) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0) {
          tables[t] = 0;
          continue;
        }
        if (dryRun) {
          tables[t] = data.length;
          continue;
        }
        tables[t] = transformAndInsert(targetDb, t, data);
      } catch (err) {
        errors.push(`${t}: ${err instanceof Error ? err.message : err}`);
        tables[t] = 0;
      }
    }
  } finally {
    closeDb(targetDb);
    try { await db.close(); } catch { /* ignore */ }
  }

  const total = Object.values(tables).reduce((a, b) => a + b, 0);
  const message = errors.length > 0
    ? `derived: migrated ${total} rows; errors: ${errors.join('; ')}`
    : `derived: migrated ${total} rows across ${Object.keys(tables).length} tables`;
  return { count: total, message, tables };
}

function transformAndInsert(db: any, table: string, rows: Array<Record<string, unknown>>): number {
  let count = 0;
  switch (table) {
    case 'event': {
      const ins = db.prepare(`INSERT INTO events (ts, kind, source, status, payload) VALUES (?, ?, ?, ?, ?)`);
      for (const r of rows) {
        try {
          ins.run(
            typeof r.ts === 'string' ? r.ts : new Date().toISOString(),
            typeof r.kind === 'string' ? r.kind : 'imported.v2',
            typeof r.source === 'string' ? r.source : 'v2-import',
            typeof r.status === 'string' ? r.status : 'ok',
            JSON.stringify(r),
          );
          count++;
        } catch { /* skip rows that violate constraints */ }
      }
      break;
    }
    case 'entity': {
      const ins = db.prepare(`INSERT OR IGNORE INTO entities (type, canonical_name, profile) VALUES (?, ?, ?)`);
      for (const r of rows) {
        const type = typeof r.type === 'string' ? r.type : 'thing';
        const name = typeof r.name === 'string' ? r.name : (typeof r.canonical_name === 'string' ? r.canonical_name : null);
        if (!name) continue;
        try {
          ins.run(type, name, typeof r.profile === 'string' ? r.profile : null);
          count++;
        } catch { /* skip */ }
      }
      break;
    }
    case 'relation': {
      // Look up subject/object by canonical_name. Skip if either side missing.
      const findEntity = db.prepare(`SELECT id FROM entities WHERE canonical_name = ?`);
      const ins = db.prepare(`INSERT INTO relations (subject_id, predicate, object_id, ts) VALUES (?, ?, ?, ?)`);
      for (const r of rows) {
        const subject = typeof r.subject === 'string' ? r.subject : (typeof r.in === 'string' ? r.in : null);
        const predicate = typeof r.predicate === 'string' ? r.predicate : 'related';
        const object = typeof r.object === 'string' ? r.object : (typeof r.out === 'string' ? r.out : null);
        if (!subject || !object) continue;
        const sRow = findEntity.get(subject) as { id: number } | undefined;
        const oRow = findEntity.get(object) as { id: number } | undefined;
        if (!sRow || !oRow) continue;
        try {
          ins.run(sRow.id, predicate, oRow.id, typeof r.ts === 'string' ? r.ts : new Date().toISOString());
          count++;
        } catch { /* skip */ }
      }
      break;
    }
    case 'prediction': {
      const ins = db.prepare(`INSERT INTO predictions (claim, confidence, deadline, resolution_method, outcome, resolved_at) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const r of rows) {
        const claim = typeof r.claim === 'string' ? r.claim : null;
        if (!claim) continue;
        try {
          ins.run(
            claim,
            typeof r.confidence === 'number' ? r.confidence : 0.5,
            typeof r.deadline === 'string' ? r.deadline : null,
            typeof r.resolution_method === 'string' ? r.resolution_method : null,
            typeof r.outcome === 'string' ? r.outcome : null,
            typeof r.resolved_at === 'string' ? r.resolved_at : null,
          );
          count++;
        } catch { /* skip */ }
      }
      break;
    }
    case 'correction': {
      const ins = db.prepare(`INSERT INTO corrections (what, correction, context, applied) VALUES (?, ?, ?, ?)`);
      for (const r of rows) {
        const what = typeof r.what === 'string' ? r.what : null;
        const correction = typeof r.correction === 'string' ? r.correction : null;
        if (!what || !correction) continue;
        try {
          ins.run(what, correction, typeof r.context === 'string' ? r.context : null, 0);
          count++;
        } catch { /* skip */ }
      }
      break;
    }
  }
  return count;
}

function migrateFlatFiles(v2UserData: string, targetUserData: string, dryRun?: boolean): number {
  const subdirs = ['artifacts', 'skills', 'jobs', 'triggers', 'scripts', 'sources', 'profile'];
  let count = 0;
  const paths = userDataPaths(targetUserData);
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
