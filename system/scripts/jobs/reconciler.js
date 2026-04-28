// Reconciler: keeps OS scheduler entries in sync with discovered job defs.
// Invoked from postinstall, robin update, the _robin-sync heartbeat job, and
// `robin jobs sync`. Exits in <10ms when nothing has changed (hash early-exit).

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { discoverJobs } from '../lib/jobs/discovery.js';
import { jobsPaths } from '../lib/jobs/paths.js';
import {
  acquireLock,
  ensureDir,
  readJSON,
  releaseLock,
  sha256,
  writeIfChanged,
  writeJSONIfChanged,
} from '../lib/jobs/atomic.js';
import {
  deleteJobState,
  listJobStates,
  regenFailures,
  regenIndex,
  regenUpcoming,
} from '../lib/jobs/state.js';
import { getAdapter } from './installer/index.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function readWorkspaceConfig(workspaceDir) {
  return readJSON(join(workspaceDir, 'user-data/robin.config.json'), {});
}

function hashJobsDir(dir) {
  if (!existsSync(dir)) return '';
  const tuples = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const p = join(dir, f);
    try {
      const st = statSync(p);
      tuples.push(`${f}\t${st.mtimeMs}\t${st.size}`);
    } catch {
      // ignore
    }
  }
  tuples.sort();
  return tuples.join('\n');
}

export function computeSyncHash(workspaceDir) {
  const paths = jobsPaths(workspaceDir);
  const a = hashJobsDir(paths.systemJobsDir);
  const b = hashJobsDir(paths.userJobsDir);
  return sha256(`SYS\n${a}\nUSER\n${b}`);
}

export function reconcile({
  workspaceDir,
  robinPath,
  force = false,
  adapter = getAdapter(),
} = {}) {
  const paths = jobsPaths(workspaceDir);
  ensureDir(paths.stateDir);
  ensureDir(paths.locksDir);
  const config = readWorkspaceConfig(workspaceDir);
  const tz = config?.user?.timezone || null;

  // Reconciler lock — prevents concurrent reconciles colliding.
  const lockResult = acquireLock(paths.syncLock, { staleMs: 5 * 60 * 1000 });
  if (lockResult === 'held') {
    return { ok: true, skipped: 'reconciler-already-running' };
  }
  try {
    return reconcileInner({ workspaceDir, robinPath, force, adapter, tz, paths });
  } finally {
    releaseLock(paths.syncLock);
  }
}

function reconcileInner({ workspaceDir, robinPath, force, adapter, tz, paths }) {
  const result = {
    added: [],
    removed: [],
    updated: [],
    skipped: [],
    warnings: [],
    orphansRemoved: [],
  };

  // Hash early-exit
  const hash = computeSyncHash(workspaceDir);
  const lastHash = existsSync(paths.syncHashFile) ? readFileSync(paths.syncHashFile, 'utf-8') : '';
  if (!force && hash === lastHash && existsSync(paths.indexMd) && existsSync(paths.upcomingMd)) {
    // workspace path may have moved; verify
    const stored = existsSync(paths.workspacePathFile) ? readFileSync(paths.workspacePathFile, 'utf-8').trim() : '';
    if (stored === workspaceDir) {
      return { ok: true, skipped: 'no-change', hash };
    }
  }

  const { jobs, errors } = discoverJobs(workspaceDir);
  for (const e of errors) {
    result.warnings.push(`${e.path || e.name}: ${(e.errors || []).join('; ')}`);
  }

  const desired = new Map();
  for (const [name, def] of jobs) {
    if (def.frontmatter.enabled === false) continue;
    if (!def.frontmatter.schedule) continue;
    desired.set(name, def);
  }

  // Adapter delta
  if (adapter) {
    let installed = [];
    try {
      installed = adapter.listEntries() || [];
    } catch (err) {
      result.warnings.push(`listEntries failed: ${err.message}`);
    }
    const installedSet = new Set(installed);
    const desiredNames = new Set(desired.keys());

    if (adapter.batched && adapter.syncAll) {
      try {
        const r = adapter.syncAll({ jobs: desired, robinPath, workspaceDir });
        if (r.changed) result.updated.push('cron');
        if (!r.ok) result.warnings.push(`syncAll: ${r.stderr}`);
      } catch (err) {
        result.warnings.push(`syncAll: ${err.message}`);
      }
    } else if (adapter.installEntry) {
      // Add / update
      for (const [name, def] of desired) {
        const r = adapter.installEntry({
          name,
          robinPath,
          workspaceDir,
          schedule: def.frontmatter.schedule,
        });
        if (!r.ok) {
          result.warnings.push(`install ${name}: ${r.stderr || 'failed'}`);
          result.skipped.push(name);
          continue;
        }
        if (installedSet.has(name)) result.updated.push(name);
        else result.added.push(name);
      }
      // Remove
      for (const name of installedSet) {
        if (!desiredNames.has(name)) {
          if (adapter.uninstallEntry) {
            adapter.uninstallEntry(name);
            result.removed.push(name);
          }
        }
      }
    }
  } else {
    result.warnings.push('no scheduler adapter for this platform');
  }

  // Orphan state cleanup
  const stateNames = [...listJobStates(workspaceDir).keys()];
  const knownNames = new Set(jobs.keys());
  for (const n of stateNames) {
    if (!knownNames.has(n)) {
      deleteJobState(workspaceDir, n);
      result.orphansRemoved.push(n);
    }
  }

  // Regenerate aggregate surfaces
  const states = listJobStates(workspaceDir);
  const generatedAt = new Date();
  try {
    regenIndex(workspaceDir, jobs, states, { generatedAt, tz });
    regenUpcoming(workspaceDir, jobs, { generatedAt, tz });
    regenFailures(workspaceDir, jobs, states, { generatedAt, tz });
  } catch (err) {
    result.warnings.push(`telemetry regen: ${err.message}`);
  }

  // Persist hash + workspace path
  writeIfChanged(paths.syncHashFile, hash);
  writeIfChanged(paths.workspacePathFile, workspaceDir);

  return { ok: true, hash, ...result };
}

// CLI entry point
async function cliMain(argv) {
  const flags = { force: false };
  for (const a of argv.slice(2)) {
    if (a === '--force') flags.force = true;
  }
  const workspaceDir = process.env.ROBIN_WORKSPACE || process.cwd();
  const robinPath = resolveRobinPath();
  const r = reconcile({ workspaceDir, robinPath, force: flags.force });
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.ok ? 0 : 1);
}

function resolveRobinPath() {
  if (process.env.ROBIN_BIN) return process.env.ROBIN_BIN;
  // Default: assume the workspace's bin/robin.js, run with the same node binary.
  // The installer bakes both paths into scheduler entries, so resolution at
  // reconcile time uses argv[1] as a fallback hint.
  const candidate = join(process.env.ROBIN_WORKSPACE || process.cwd(), 'bin/robin.js');
  return process.execPath + ' ' + candidate;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain(process.argv).catch((err) => {
    process.stderr.write(`reconciler error: ${err.message}\n`);
    process.exit(1);
  });
}
