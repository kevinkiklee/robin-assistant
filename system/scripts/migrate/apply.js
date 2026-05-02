import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHelpers } from './lib/migration-helpers.js';

// When robin-assistant is installed globally (e.g. `npm i -g robin-assistant`),
// the migration files ship inside the package directory while the workspace
// lives elsewhere. opts.migrationsDir lets callers override the default
// `<workspaceDir>/system/migrations` lookup so `robin init` and the global
// install path can still apply migrations.
function resolveMigrationsDir(workspaceDir, opts = {}) {
  return opts.migrationsDir || join(workspaceDir, 'system/migrations');
}

// Fast path: a single mtime + count check decides whether any migration is
// pending. Skips the per-file dynamic import dance ~95% of the time. Only
// triggers a full scan when migrations directory has changed since the last
// applied migration was recorded.
// Resolve the migrations-applied log path. Pre-0021 workspaces store it at
// user-data/.migrations-applied.json; after 0021 it moves to
// user-data/ops/state/migrations-applied.json. Read prefers the new path
// when present; otherwise falls back to the old.
function logReadPath(workspaceDir) {
  const newP = join(workspaceDir, 'user-data/ops/state/migrations-applied.json');
  if (existsSync(newP)) return newP;
  const oldP = join(workspaceDir, 'user-data/.migrations-applied.json');
  if (existsSync(oldP)) return oldP;
  return newP;
}

// Where to write the log. Always the new path, except when the old path is
// present and the new path is absent (pre-0021 in-flight); in that case keep
// writing to the old path so 0021 can move it cleanly.
function logWritePath(workspaceDir) {
  const newP = join(workspaceDir, 'user-data/ops/state/migrations-applied.json');
  if (existsSync(newP)) return newP;
  const oldP = join(workspaceDir, 'user-data/.migrations-applied.json');
  if (existsSync(oldP)) return oldP;
  return newP;
}

function fastPathHasPending(workspaceDir, opts = {}) {
  const migrationsDir = resolveMigrationsDir(workspaceDir, opts);
  const logPath = logReadPath(workspaceDir);
  if (!existsSync(migrationsDir)) return false;
  if (!existsSync(logPath)) return true; // never run yet
  try {
    const log = JSON.parse(readFileSync(logPath, 'utf-8'));
    const onDisk = readdirSync(migrationsDir).filter((f) => f.endsWith('.js'));
    if (onDisk.length > log.length) return true; // new migration files exist
    const dirMtime = statSync(migrationsDir).mtimeMs;
    const lastApplied = log.length > 0 ? new Date(log[log.length - 1].appliedAt).getTime() : 0;
    if (dirMtime > lastApplied + 1000) return true; // files changed since last apply
    return false;
  } catch {
    return true; // on any parse/io error, fall through to full scan
  }
}

export async function runPendingMigrations(workspaceDir = process.cwd(), opts = {}) {
  // Fast path: if nothing has changed since last apply, skip the dynamic
  // import + per-file work entirely.
  if (!opts.dryRun && !opts.force && !fastPathHasPending(workspaceDir, opts)) {
    return { applied: [], would: [] };
  }

  const migrationsDir = resolveMigrationsDir(workspaceDir, opts);
  const logPath = logWritePath(workspaceDir);
  if (!existsSync(migrationsDir)) return { applied: [], would: [] };

  const readPath = logReadPath(workspaceDir);
  const log = existsSync(readPath) ? JSON.parse(readFileSync(readPath, 'utf-8')) : [];
  const applied = new Set(log.map(e => e.id));

  const candidates = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  const pending = [];
  for (const file of candidates) {
    const mod = await import(pathToFileURL(join(migrationsDir, file)).href);
    if (!mod.id) throw new Error(`migration ${file} missing exported id`);
    if (!applied.has(mod.id)) pending.push(mod);
  }

  if (pending.length === 0) return { applied: [], would: [] };
  if (opts.dryRun) return { applied: [], would: pending.map(m => m.id) };

  // Pre-migration backup
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(workspaceDir, 'backup');
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `pre-migration-${ts}.tar.gz`);
  if (existsSync(join(workspaceDir, 'user-data'))) {
    execSync(`tar -czf ${JSON.stringify(backupPath)} -C ${JSON.stringify(workspaceDir)} user-data`, { stdio: 'inherit' });
  }

  const helpers = createHelpers(workspaceDir);
  const migrationOpts = { interactive: opts.interactive ?? true };
  const result = { applied: [], would: [] };
  for (const m of pending) {
    try {
      await m.up({ workspaceDir, helpers, opts: migrationOpts });
      log.push({ id: m.id, appliedAt: new Date().toISOString(), backup: backupPath });
      result.applied.push(m.id);
    } catch (err) {
      console.error(`Migration ${m.id} failed: ${err.message}`);
      console.error(`Restore with: tar -xzf ${backupPath} -C ${workspaceDir}`);
      throw err;
    }
  }
  // After migrations run, re-resolve the write path because 0021 may have
  // moved the log file mid-run.
  const finalLogPath = logWritePath(workspaceDir);
  mkdirSync(dirname(finalLogPath), { recursive: true });
  writeFileSync(finalLogPath, JSON.stringify(log, null, 2) + '\n');
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  const ci = process.argv.includes('--ci') || process.env.CI === 'true';
  const result = await runPendingMigrations(process.cwd(), { dryRun, interactive: !ci });
  if (dryRun) {
    console.log('Would apply:', result.would.join(', ') || '(none)');
  } else {
    console.log('Applied:', result.applied.join(', ') || '(none)');
  }
}
