// Read-only probes used by `robin doctor` to render its default status
// overview. None of these are operational invariants — they're rich data
// displays. Pure-ish: side effects limited to filesystem reads, network
// probes, and one subprocess spawn (supervisor status).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { surql } from 'surrealdb';
import { paths } from '../../../config/data-store.js';
import { readFileTail } from '../../../config/file-tail.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { detectLayoutVersion, LEGACY_STRAY_DIRS } from '../../install/layout-migrator.js';

const LOG_TAIL_BYTES = 16 * 1024;
const LOG_ERROR_RE = /\b(error|exception|fail(ed|ure)?|fatal)\b/i;

// Find the node binary the daemon actually uses. The daemon is launched by
// launchd from a plist whose Program string is captured at install time, so
// it can diverge from whatever `/usr/bin/env node` resolves to in the CLI's
// shell (a common nvm vs Homebrew skew). We prefer that path so the probe
// answers the question that matters: does the *daemon* load better-sqlite3?
function daemonNodePath() {
  if (platform() !== 'darwin') return null;
  const plistPath = join(homedir(), 'Library/LaunchAgents/io.robin-assistant.mcp.plist');
  if (!existsSync(plistPath)) return null;
  try {
    const xml = readFileSync(plistPath, 'utf8');
    const match = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(xml);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

const PROBE_SOURCE =
  "import('better-sqlite3').then(m=>{const D=m.default??m;new D(':memory:').close();process.exit(0)}).catch(e=>{process.stderr.write(String(e.message||e));process.exit(1)})";

export async function probeBetterSqlite3() {
  // Prefer testing against the daemon's actual node binary (read from the
  // launchd plist). Fall back to in-process import for non-darwin or when
  // the plist isn't present.
  const nodePath = daemonNodePath();
  if (nodePath && existsSync(nodePath)) {
    const r = spawnSync(nodePath, ['-e', PROBE_SOURCE], { encoding: 'utf8' });
    if (r.status === 0) {
      return { ok: true, message: 'native bindings: better-sqlite3 loadable (daemon node)' };
    }
    const msg = (r.stderr ?? '').split('\n')[0];
    if (/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/.test(msg)) {
      return {
        ok: false,
        message: 'native bindings: better-sqlite3 ABI mismatch (daemon node)',
        details: [`probed via ${nodePath}`, 'fix: pnpm rebuild better-sqlite3'],
      };
    }
    return {
      ok: false,
      message: 'native bindings: better-sqlite3 unavailable (daemon node)',
      details: [msg, `probed via ${nodePath}`],
    };
  }
  try {
    const mod = await import('better-sqlite3');
    const Database = mod.default ?? mod;
    const db = new Database(':memory:');
    db.close();
    return { ok: true, message: 'native bindings: better-sqlite3 loadable' };
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/.test(msg)) {
      return {
        ok: false,
        message: 'native bindings: better-sqlite3 ABI mismatch',
        details: ['fix: pnpm rebuild better-sqlite3'],
      };
    }
    return {
      ok: false,
      message: 'native bindings: better-sqlite3 unavailable',
      details: [msg.split('\n')[0]],
    };
  }
}

export function probePort(port, { netModule = { createServer } } = {}) {
  return new Promise((resolve) => {
    const server = netModule.createServer();
    server.once('error', (err) => {
      server.close();
      if (err?.code === 'EADDRINUSE') resolve({ free: false, error: 'EADDRINUSE' });
      else resolve({ free: false, error: err?.code ?? 'unknown' });
    });
    server.once('listening', () => {
      server.close(() => resolve({ free: true }));
    });
    try {
      server.listen({ port, host: '127.0.0.1', exclusive: true });
    } catch (err) {
      resolve({ free: false, error: err?.code ?? 'unknown' });
    }
  });
}

export function probeSupervisor({ spawn = spawnSync, plat = platform() } = {}) {
  if (plat === 'darwin') {
    const r = spawn('launchctl', ['list', 'io.robin-assistant.mcp'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    if (r.error) return { status: 'unknown', detail: r.error.message };
    if (r.status === 0) return { status: 'loaded' };
    return { status: 'not loaded' };
  }
  if (plat === 'linux') {
    const r = spawn('systemctl', ['--user', 'is-active', 'robin-mcp'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    if (r.error) return { status: 'unknown', detail: r.error.message };
    const v = (r.stdout ?? '').trim();
    if (v === 'active') return { status: 'active' };
    return { status: v || 'inactive' };
  }
  return { status: 'unsupported platform' };
}

export async function probeSurreal(httpUrl, { fetchFn = globalThis.fetch } = {}) {
  try {
    const url = `${httpUrl.replace(/\/$/, '')}/health`;
    const resp = await fetchFn(url, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) return { ok: true, message: `reachable at ${httpUrl} (HTTP ${resp.status})` };
    return { ok: false, message: `unhealthy at ${httpUrl} (HTTP ${resp.status})` };
  } catch (e) {
    return {
      ok: false,
      message: `unreachable at ${httpUrl} (${e?.code ?? e?.message ?? 'unknown'})`,
    };
  }
}

export function probeBiographerLog() {
  const logPath = join(paths.data.logs(), 'biographer.log');
  if (!existsSync(logPath)) return { exists: false };
  try {
    const stat = statSync(logPath);
    const tail = readFileTail(logPath, LOG_TAIL_BYTES);
    const lines = tail.split('\n').filter(Boolean);
    const errors = lines.filter((l) => LOG_ERROR_RE.test(l));
    // last_error is only useful when it points at a CURRENT problem. If the
    // biographer has written STALE_AFTER_LINES of clean output since the
    // most recent error, the system has clearly moved past it — surface only
    // the count, not the stale message. Previously a single historical
    // error would haunt `robin doctor` indefinitely because the biographer
    // log was never rotated (now fixed in log-rotate.js).
    const STALE_AFTER_LINES = 20;
    let last_error = errors[errors.length - 1] ?? null;
    if (last_error) {
      const lastErrorIndex = lines.lastIndexOf(last_error);
      const linesAfter = lines.length - 1 - lastErrorIndex;
      if (linesAfter >= STALE_AFTER_LINES) last_error = null;
    }
    return {
      exists: true,
      size: stat.size,
      tail_lines: lines.length,
      error_lines: errors.length,
      last_error,
      mtime: stat.mtime.toISOString(),
    };
  } catch (e) {
    return { exists: true, error: e.message };
  }
}

export async function probeIntegrationFreshness() {
  let db;
  try {
    db = await connect({ engine: await defaultDbUrl() });
    const [rows] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const value = rows[0]?.value ?? {};
    const integrations = value.integrations ?? {};
    const now = Date.now();
    let total = 0;
    let stale = 0;
    const staleNames = [];
    for (const [name, row] of Object.entries(integrations)) {
      if (!row?.cadence_ms) continue;
      total += 1;
      const last = row.last_sync_at ? new Date(row.last_sync_at).getTime() : null;
      if (last === null) continue;
      const threshold = 2 * row.cadence_ms;
      if (now - last > threshold) {
        stale += 1;
        staleNames.push(name);
      }
    }
    return { total, stale, stale_names: staleNames };
  } catch (e) {
    return { error: e.message };
  } finally {
    if (db) await close(db);
  }
}

/**
 * Layout-version + stray-legacy-dir scan. Surfaced in `robin doctor` so a
 * partial or pending v1→v2 migration is visible at a glance. The migration
 * itself runs automatically via `ensureHome()`; doctor never moves files.
 */
export function probeLayout({ home = paths.data.home() } = {}) {
  const version = detectLayoutVersion(home);
  const strays = LEGACY_STRAY_DIRS.filter((rel) => existsSync(join(home, rel)));
  const expectedV2 = [
    'artifacts',
    'jobs',
    'skills',
    'sources',
    'upload',
    'config',
    'cognition',
    'io',
    'data',
    'runtime',
  ];
  const missing = version === 'v2' ? expectedV2.filter((d) => !existsSync(join(home, d))) : [];
  return { version, strays, missing };
}
