import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHelpers } from './lib/migration-helpers.js';

// Fast path: a single mtime + count check decides whether any migration is
// pending. Skips the per-file dynamic import dance ~95% of the time. Only
// triggers a full scan when migrations directory has changed since the last
// applied migration was recorded.
function fastPathHasPending(workspaceDir) {
  const migrationsDir = join(workspaceDir, 'system/migrations');
  const logPath = join(workspaceDir, 'user-data/.migrations-applied.json');
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
  if (!opts.dryRun && !opts.force && !fastPathHasPending(workspaceDir)) {
    return { applied: [], would: [] };
  }

  const migrationsDir = join(workspaceDir, 'system/migrations');
  const logPath = join(workspaceDir, 'user-data/.migrations-applied.json');
  if (!existsSync(migrationsDir)) return { applied: [], would: [] };

  const log = existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf-8')) : [];
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
  writeFileSync(logPath, JSON.stringify(log, null, 2) + '\n');
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
