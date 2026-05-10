// `robin doctor` — extended health overview.
//
// Flags:
//   --rebaseline             rewrite <robinHome>/manifest.json from current state
//   --purge-stale-sessions   delete runtime_sessions rows whose status='stale'
//   --lint-hooks             list robin-owned hook entries in
//                            ~/.claude/settings.json + ~/.gemini/settings.json
//
// With NO flags: print a one-fact-per-line status overview that includes
// tamper baseline, daemon, secrets, config, native bindings (better-sqlite3),
// port reachability, supervisor (launchctl/systemctl), recent biographer.log
// errors, and integration freshness rollup.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { surql } from 'surrealdb';
import { isPidAlive } from '../../daemon/lock.js';
import { purgeStaleSessions } from '../../daemon/sessions.js';
import { readDaemonState } from '../../daemon/state.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { computeManifest, writeManifest } from '../../install/manifest.js';
import { ensureHome, packageRootDir, paths } from '../../runtime/home.js';
import { parseArgs } from '../args.js';

function shimPrefix() {
  return join(packageRootDir(), 'bin', 'robin-hook.sh');
}

function readSettingsHooks(settingsPath) {
  if (!existsSync(settingsPath)) return null;
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!parsed.hooks || typeof parsed.hooks !== 'object') return null;
    return parsed.hooks;
  } catch {
    return null;
  }
}

function* iterateRobinOwnedEntries(hooks, prefix) {
  for (const phase of Object.keys(hooks)) {
    const arr = hooks[phase];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const subs = Array.isArray(entry.hooks) ? entry.hooks : [];
      for (const h of subs) {
        if (!h || h.type !== 'command' || typeof h.command !== 'string') continue;
        if (h.command.startsWith(prefix)) {
          yield { phase, matcher: entry.matcher ?? null, command: h.command };
        }
      }
    }
  }
}

async function doRebaseline(out) {
  await ensureHome();
  const m = await computeManifest();
  await writeManifest(m);
  out(`tamper baseline rewritten (${m.files.length} files)`);
}

async function doPurgeStaleSessions(out, err, deps = {}) {
  // `openDb` is injectable so tests can swap in a mem:// engine; production
  // path uses the rocksdb store with the daemon-lock guard.
  if (typeof deps.openDb === 'function') {
    const db = await deps.openDb();
    try {
      const n = await purgeStaleSessions(db);
      out(`purged ${n} stale sessions`);
    } finally {
      await (deps.closeDb ?? close)(db);
    }
    return;
  }
  await ensureHome();
  const p = paths();
  const daemonState = await readDaemonState(p.daemonState);
  if (daemonState && isPidAlive(daemonState.pid)) {
    err('daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  const release = await acquire(p.daemonLock);
  try {
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      const n = await purgeStaleSessions(db);
      out(`purged ${n} stale sessions`);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}

async function doLintHooks(out, { homeDir = homedir() } = {}) {
  const prefix = shimPrefix();
  const hosts = [
    { name: 'claude', path: join(homeDir, '.claude', 'settings.json') },
    { name: 'gemini', path: join(homeDir, '.gemini', 'settings.json') },
  ];
  let total = 0;
  for (const host of hosts) {
    const hooks = readSettingsHooks(host.path);
    if (!hooks) {
      out(`${host.name}: no settings.json or no hooks`);
      continue;
    }
    let count = 0;
    for (const e of iterateRobinOwnedEntries(hooks, prefix)) {
      const matcher = e.matcher ? ` matcher=${e.matcher}` : '';
      out(`${host.name}: ${e.phase}${matcher} → ${e.command}`);
      count += 1;
    }
    if (count === 0) {
      out(`${host.name}: no robin-owned hook entries`);
    }
    total += count;
  }
  out(`total robin-owned hook entries: ${total}`);
}

async function probeBetterSqlite3() {
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
        details: ['fix: npm rebuild better-sqlite3'],
      };
    }
    return {
      ok: false,
      message: 'native bindings: better-sqlite3 unavailable',
      details: [msg.split('\n')[0]],
    };
  }
}

function probePort(port, { netModule = { createServer } } = {}) {
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

function probeSupervisor({ spawn = spawnSync, plat = platform() } = {}) {
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

const LOG_TAIL_BYTES = 16 * 1024;
const LOG_ERROR_RE = /\b(error|exception|fail(ed|ure)?|fatal)\b/i;

function probeBiographerLog(p) {
  const logPath = join(p.cache, 'logs', 'biographer.log');
  if (!existsSync(logPath)) return { exists: false };
  try {
    const stat = statSync(logPath);
    const size = stat.size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const fd = readFileSync(logPath, { encoding: 'utf8' });
    const tail = fd.slice(start);
    const lines = tail.split('\n').filter(Boolean);
    const errors = lines.filter((l) => LOG_ERROR_RE.test(l));
    return {
      exists: true,
      size,
      tail_lines: lines.length,
      error_lines: errors.length,
      last_error: errors[errors.length - 1] ?? null,
      mtime: stat.mtime.toISOString(),
    };
  } catch (e) {
    return { exists: true, error: e.message };
  }
}

async function probeIntegrationFreshness(p) {
  let db;
  try {
    db = await connect({ engine: `rocksdb://${p.db}` });
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

async function doStatus(out, deps = {}) {
  const p = paths();
  out(`ROBIN_HOME: ${p.home}`);
  const manifestExists = existsSync(join(p.home, 'manifest.json'));
  out(`manifest: ${manifestExists ? 'present' : 'missing'}`);
  const daemonState = await readDaemonState(p.daemonState);
  let daemonRunning = false;
  if (daemonState && isPidAlive(daemonState.pid)) {
    out(`daemon: running (pid=${daemonState.pid}, port=${daemonState.port ?? '?'})`);
    daemonRunning = true;
  } else if (daemonState) {
    out(`daemon: stale state file (port=${daemonState.port ?? '?'}, process not alive)`);
  } else {
    out('daemon: not running');
  }
  const secretsEnv = join(p.secrets, '.env');
  out(`secrets file: ${existsSync(secretsEnv) ? 'present' : 'missing'}`);
  const configExists = existsSync(p.config);
  out(`config: ${configExists ? 'present' : 'missing'}`);

  // Native bindings — the failure that bit us at chrome/lrc test load.
  const sqlite = await (deps.probeBetterSqlite3 ?? probeBetterSqlite3)();
  out(sqlite.message);
  for (const d of sqlite.details ?? []) out(`  ${d}`);

  // Port — only meaningful when state file references one. If daemon is alive,
  // the port should be busy (held by daemon). If state file is stale, the port
  // should be free; if it isn't, something else is squatting on it.
  if (daemonState?.port) {
    const result = await (deps.probePort ?? probePort)(daemonState.port);
    if (daemonRunning) {
      if (result.free) out(`port ${daemonState.port}: free (unexpected — daemon may not be bound)`);
      else out(`port ${daemonState.port}: in use (expected — daemon is bound)`);
    } else {
      if (result.free) out(`port ${daemonState.port}: free`);
      else out(`port ${daemonState.port}: held by another process (${result.error ?? 'unknown'})`);
    }
  }

  // Supervisor — launchd on macOS, systemd --user on linux.
  const sup = (deps.probeSupervisor ?? probeSupervisor)();
  out(`supervisor: ${sup.status}${sup.detail ? ` (${sup.detail})` : ''}`);

  // Biographer log — surface recent errors.
  const log = (deps.probeBiographerLog ?? probeBiographerLog)(p);
  if (!log.exists) {
    out('biographer.log: absent (no Stop hook fires yet, or never ran biographer)');
  } else if (log.error) {
    out(`biographer.log: present, read failed (${log.error})`);
  } else {
    out(
      `biographer.log: ${log.tail_lines} recent lines, ${log.error_lines} flagged, mtime=${log.mtime}`,
    );
    if (log.last_error) out(`  last error: ${log.last_error.slice(0, 200)}`);
  }

  // Integration freshness — count integrations behind 2× their cadence.
  // Skipped when the daemon isn't alive: opening the embedded rocksdb store
  // here while the daemon could come up at any moment risks lock contention,
  // and the runtime:scheduler row is only meaningful when the daemon is the
  // one driving it. Tests inject probeIntegrationFreshness to verify the
  // rendering path independent of an actual DB.
  if (deps.probeIntegrationFreshness || daemonRunning) {
    const fresh = await (deps.probeIntegrationFreshness ?? probeIntegrationFreshness)(p);
    if (fresh.error) {
      out(`integrations: read failed (${fresh.error})`);
    } else if (fresh.total === 0) {
      out('integrations: none scheduled');
    } else {
      out(
        `integrations: ${fresh.stale}/${fresh.total} stale (>2× cadence)${
          fresh.stale > 0 ? ` — ${fresh.stale_names.join(', ')}` : ''
        }`,
      );
    }
  } else {
    out('integrations: skipped (daemon not running)');
  }
}

export async function doctor(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));

  const wantRebaseline = args.flags.rebaseline === true;
  const wantPurge = args.flags['purge-stale-sessions'] === true;
  const wantLint = args.flags['lint-hooks'] === true;

  if (!wantRebaseline && !wantPurge && !wantLint) {
    await doStatus(out, deps);
    return;
  }

  if (wantRebaseline) await doRebaseline(out);
  if (wantPurge)
    await doPurgeStaleSessions(out, err, { openDb: deps.openDb, closeDb: deps.closeDb });
  if (wantLint) await doLintHooks(out, { homeDir: deps.homeDir });
}
