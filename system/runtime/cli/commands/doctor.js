// `robin doctor` — extended health overview.
//
// Flags:
//   --rebaseline             rewrite <robinHome>/manifest.json from current state
//   --purge-stale-sessions   delete runtime_sessions rows whose status='stale'
//   --lint-hooks             list robin-owned hook entries in
//                            ~/.claude/settings.json + ~/.gemini/settings.json
//
// With NO flags: print a one-fact-per-line status overview that includes
// introspection baseline, daemon, secrets, config, native bindings
// (better-sqlite3), port reachability, supervisor (launchctl/systemctl),
// recent biographer.log errors, and integration freshness rollup.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  renameSync as renameSyncFs,
  statSync,
  writeFileSync as writeFileSyncFs,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { surql } from 'surrealdb';
import { readDaemonState } from '../../../config/daemon-state.js';
import {
  ensureHome,
  packageRootDir,
  paths,
  pointerExists,
  readHostIntegrations,
  readPointer,
  robinHome,
} from '../../../config/data-store.js';
import { readFileTail } from '../../../config/file-tail.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { phaseOrdered } from '../../invariants/index.js';
import installPointerPresent from '../../invariants/install.pointer-present.js';
import { recordDivergence } from '../../invariants/divergence-log.js';
import { isInSync, renderRunbook, replaceSentinelBlock } from '../../invariants/runbook.js';
import { run as runInvariants } from '../../invariants/runner.js';
import { makeCtx as makeInvariantCtx } from '../../invariants/ctx.js';
import { isPidAlive } from '../../daemon/lock.js';
import { purgeStaleSessions } from '../../daemon/sessions.js';
import { detectLayoutVersion, LEGACY_STRAY_DIRS } from '../../install/layout-migrator.js';
import { computeManifest, writeManifest } from '../../install/manifest.js';
import { parseArgs } from '../args.js';

function shimPrefix() {
  return join(packageRootDir(), 'system', 'bin', 'robin-hook.sh');
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
  out(`introspection baseline rewritten (${m.files.length} files)`);
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
  const daemonState = await readDaemonState(paths.data.daemonState());
  if (daemonState && isPidAlive(daemonState.pid)) {
    err('daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  const release = await acquire(paths.data.daemonLock());
  try {
    const db = await connect({ engine: await defaultDbUrl() });
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

async function probeSurreal(httpUrl, { fetchFn = globalThis.fetch } = {}) {
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

function probeBiographerLog() {
  const logPath = join(paths.data.logs(), 'biographer.log');
  if (!existsSync(logPath)) return { exists: false };
  try {
    const stat = statSync(logPath);
    // `readFileTail` (config/file-tail.js) is the package-wide helper for
    // bounded tail reads — also used by capture/transcript and the
    // intuition handler. Keeps one tail-reading code path everywhere.
    const tail = readFileTail(logPath, LOG_TAIL_BYTES);
    const lines = tail.split('\n').filter(Boolean);
    const errors = lines.filter((l) => LOG_ERROR_RE.test(l));
    return {
      exists: true,
      size: stat.size,
      tail_lines: lines.length,
      error_lines: errors.length,
      last_error: errors[errors.length - 1] ?? null,
      mtime: stat.mtime.toISOString(),
    };
  } catch (e) {
    return { exists: true, error: e.message };
  }
}

async function probeIntegrationFreshness() {
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
function probeLayout({ home = paths.data.home() } = {}) {
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

async function doStatus(out, deps = {}) {
  out(`ROBIN_HOME: ${paths.data.home()}`);
  const manifestExists = existsSync(paths.data.manifest());
  out(`manifest: ${manifestExists ? 'present' : 'missing'}`);

  // Layout — surfaces pending v1→v2 migration and stray legacy directories.
  const layout = (deps.probeLayout ?? probeLayout)();
  if (layout.version === 'fresh') {
    out('layout: fresh install (no marker yet)');
  } else if (layout.version === 'v1') {
    out('layout: v1 (run any robin command, or `robin migrate-user-data`, to migrate)');
  } else {
    out('layout: v2');
  }
  if (layout.strays.length > 0) {
    out(
      `  stray legacy: ${layout.strays.join(', ')} — run \`robin migrate-user-data\` to clean up`,
    );
  }
  if (layout.missing.length > 0) {
    out(`  MISSING expected v2 dirs: ${layout.missing.join(', ')} (failed mid-migration?)`);
  }
  const daemonState = await readDaemonState(paths.data.daemonState());
  let daemonRunning = false;
  if (daemonState && isPidAlive(daemonState.pid)) {
    out(`daemon: running (pid=${daemonState.pid}, port=${daemonState.port ?? '?'})`);
    daemonRunning = true;
    if (!daemonState.auth_token) {
      out('  auth_token: MISSING (daemon predates auth gate — `robin mcp restart`)');
    } else {
      out('  auth_token: present');
    }
  } else if (daemonState) {
    out(`daemon: stale state file (port=${daemonState.port ?? '?'}, process not alive)`);
  } else {
    out('daemon: not running');
  }
  const secretsEnv = join(paths.data.secrets(), '.env');
  out(`secrets file: ${existsSync(secretsEnv) ? 'present' : 'missing'}`);
  const configExists = existsSync(paths.data.config());
  out(`config: ${configExists ? 'present' : 'missing'}`);

  // Surreal server — when db.url is ws/wss, the daemon depends on the
  // standalone server. Probe its /health endpoint so users can tell a
  // "daemon down" issue from a "surreal down" issue at a glance.
  try {
    const dbUrl = await defaultDbUrl();
    if (/^wss?:\/\//.test(dbUrl)) {
      const httpUrl = dbUrl.replace(/^ws/, 'http');
      const surreal = await (deps.probeSurreal ?? probeSurreal)(httpUrl);
      out(`surreal server: ${surreal.message}`);
    }
  } catch {
    /* surreal check is supplementary; never fail doctor over it */
  }

  // Engine check: surface mismatch between config and on-disk DB so a daemon
  // configured for embedded `surrealkv` doesn't quietly open a stale `rocksdb`
  // store. Skipped when db.url points at a standalone server (ws/wss/http) —
  // in that mode the on-disk format is owned by the surreal binary, not by
  // our connect() path, so a `surrealkv:` directory under a `ws:` config is
  // expected, not drift.
  try {
    const dbUrl = await defaultDbUrl();
    const engine = dbUrl.split('://')[0];
    if (/^wss?$|^https?$/.test(engine)) {
      out(`engine: ${engine} (remote — on-disk format owned by surreal server)`);
    } else {
      const dbDir = paths.data.db();
      let onDisk = null;
      if (existsSync(join(dbDir, 'CURRENT'))) onDisk = 'rocksdb';
      else if (existsSync(join(dbDir, 'rev')) || existsSync(join(dbDir, 'lock')))
        onDisk = 'surrealkv';
      if (onDisk && onDisk !== engine) {
        out(`engine: ${engine} (config) ≠ ${onDisk} (on-disk) — destructive reset required`);
      } else {
        out(`engine: ${engine}${onDisk ? '' : ' (no on-disk DB yet)'}`);
      }
    }
  } catch (e) {
    out(`engine: error resolving (${e.message})`);
  }

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
  const log = (deps.probeBiographerLog ?? probeBiographerLog)();
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
    const fresh = await (deps.probeIntegrationFreshness ?? probeIntegrationFreshness)();
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

  // Data section — host-integrations manifest drift detection.
  const data = await doctorData();
  out('');
  out('── Data section ──────────────────────────');
  out(`home: ${data.home ?? '(not resolved)'}`);
  if (data.drift.length === 0) {
    out('no drift');
  } else {
    out(`drift (${data.drift.length}):`);
    for (const d of data.drift) {
      out(`  • ${d.path ?? '(home)'}: ${d.reason}`);
    }
  }
}

export async function doctorData() {
  const drift = [];
  let homeResolved = null;
  try {
    homeResolved = robinHome();
  } catch (e) {
    drift.push({ path: null, reason: `home resolution: ${e.message}` });
    return { home: null, drift };
  }
  const pointer = readPointer();
  const envOverride = process.env.ROBIN_HOME;
  if (envOverride && pointer?.home && envOverride !== pointer.home) {
    drift.push({
      path: null,
      reason: `$ROBIN_HOME (${envOverride}) does not match .robin-home (${pointer.home})`,
    });
  }
  let manifest;
  try {
    manifest = await readHostIntegrations();
  } catch (e) {
    drift.push({ path: paths.data.hostIntegrations(), reason: `manifest read: ${e.message}` });
    return { home: homeResolved, drift };
  }
  for (const e of manifest.entries) {
    if (!existsSync(e.path)) {
      drift.push({ path: e.path, reason: 'target file missing' });
      continue;
    }
    if (e.kind === 'claude-hooks' || e.kind === 'gemini-hooks') {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(e.path, 'utf8'));
      } catch (err) {
        drift.push({ path: e.path, reason: `target file malformed: ${err.message}` });
        continue;
      }
      for (const own of e.owned ?? []) {
        const phaseArr = parsed?.hooks?.[own.phase];
        const present =
          Array.isArray(phaseArr) &&
          phaseArr.some(
            (entry) =>
              Array.isArray(entry?.hooks) && entry.hooks.some((h) => h?.command === own.command),
          );
        if (!present) {
          drift.push({ path: e.path, reason: `command not present: ${own.command}` });
        }
      }
    }
    if ((e.kind === 'launchd-plist' || e.kind === 'systemd-unit') && e.expectedHome) {
      if (e.expectedHome !== homeResolved) {
        drift.push({
          path: e.path,
          reason: `expectedHome (${e.expectedHome}) ≠ resolved home (${homeResolved})`,
        });
      }
    }
  }
  return { home: homeResolved, drift };
}

/**
 * `--emit-runbook` family. Writes the generated runbook to stdout (no flags),
 * to a file in-place (--write), or runs a CI drift check (--check).
 */
async function doEmitRunbook(out, err, { write = false, check = false, claudeMdPath } = {}) {
  const body = renderRunbook();
  if (!write && !check) {
    out(body);
    return 0;
  }
  const path = claudeMdPath ?? join(packageRootDir(), 'CLAUDE.md');
  if (!existsSync(path)) {
    err(`CLAUDE.md not found at ${path}`);
    return 4;
  }
  const existing = readFileSync(path, 'utf8');
  if (check) {
    if (isInSync(existing, body)) {
      out('runbook in sync');
      return 0;
    }
    err('runbook drift detected; run `robin doctor --emit-runbook --write` to regenerate.');
    return 1;
  }
  // write
  const next = replaceSentinelBlock(existing, body);
  if (next === existing) {
    out('runbook already in sync');
    return 0;
  }
  const tmp = `${path}.tmp`;
  writeFileSyncFs(tmp, next, 'utf8');
  renameSyncFs(tmp, path);
  out(`runbook written to ${path}`);
  return 0;
}

/**
 * `--invariants` (stage 5): run the doctor trigger across the registry and
 * print a compact status table. Read-only; never repairs.
 */
async function doInvariantsRender(out) {
  const ctx = makeInvariantCtx({ paths, trigger: 'doctor', logFallback: false });
  const report = await runInvariants({
    trigger: 'doctor',
    ctx,
    invariants: phaseOrdered(),
  });
  let crit = 0;
  let warn = 0;
  let info = 0;
  let ok = 0;
  let skipped = 0;
  for (const r of report.results) {
    if (r.status === 'skipped') {
      skipped++;
      continue;
    }
    if (r.status === 'ok') {
      ok++;
      out(`✓ ${r.name}`);
      continue;
    }
    // fail
    if (r.level === 'critical') crit++;
    else if (r.level === 'warn') warn++;
    else info++;
    const tag = r.level === 'critical' ? 'X' : '!';
    out(`${tag} ${r.name}  [${r.level}]  ${r.error ?? ''}`);
  }
  out('');
  out(`Summary: ${ok} ok · ${warn} warn · ${crit} critical · ${info} info · ${skipped} skipped`);
  if (crit > 0) return 2;
  if (warn > 0) return 1;
  return 0;
}

/**
 * `--diff-legacy` (stage 2): compare framework's install.pointer_present
 * verdict against the legacy probe (`pointerExists`). Append disagreements
 * to the divergence log.
 */
async function doDiffLegacy(out, { logPath = paths.data.divergenceLog() } = {}) {
  const legacyOk = pointerExists();
  const fw = await installPointerPresent.check();
  const agree = (legacyOk === true) === (fw.ok === true);
  out(`legacy pointerExists(): ${legacyOk}`);
  out(`framework install.pointer_present.ok: ${fw.ok}`);
  if (fw.error) out(`framework error: ${fw.error}`);
  if (!agree) {
    out('DIVERGENCE: legacy and framework disagree');
    recordDivergence(logPath, {
      invariant: 'install.pointer_present',
      legacy: { ok: legacyOk },
      framework: { ok: fw.ok, error: fw.error, evidence: fw.evidence },
    });
    out(`  recorded to ${logPath}`);
  } else {
    out('agree');
  }
}

export async function doctor(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));

  const wantRebaseline = args.flags.rebaseline === true;
  const wantPurge = args.flags['purge-stale-sessions'] === true;
  const wantLint = args.flags['lint-hooks'] === true;
  const wantHealth = args.flags.health === true;
  const wantDiffLegacy = args.flags['diff-legacy'] === true;
  const wantEmitRunbook = args.flags['emit-runbook'] === true;
  const wantInvariants = args.flags.invariants === true;

  if (wantHealth) {
    const wantJson = args.flags.json === true;
    const { runHealth } = await import('../health.js');
    const openDb = deps.openDb ?? (async () => connect({ engine: await defaultDbUrl() }));
    const closeDb = deps.closeDb ?? ((d) => close(d));
    const db = await openDb();
    try {
      const result = await runHealth(db, { json: wantJson });
      out(result.output);
      if (typeof process !== 'undefined') process.exitCode = result.exitCode;
    } finally {
      await closeDb(db).catch(() => {});
    }
    return;
  }

  if (wantDiffLegacy) {
    await doDiffLegacy(out, { logPath: deps.divergenceLogPath });
    return;
  }

  if (wantEmitRunbook) {
    const code = await doEmitRunbook(out, err, {
      write: args.flags.write === true,
      check: args.flags.check === true,
      claudeMdPath: deps.claudeMdPath,
    });
    if (typeof process !== 'undefined') process.exitCode = code;
    return;
  }

  if (wantInvariants) {
    const code = await doInvariantsRender(out);
    if (typeof process !== 'undefined') process.exitCode = code;
    return;
  }

  if (!wantRebaseline && !wantPurge && !wantLint) {
    await doStatus(out, deps);
    return;
  }

  if (wantRebaseline) await doRebaseline(out);
  if (wantPurge)
    await doPurgeStaleSessions(out, err, { openDb: deps.openDb, closeDb: deps.closeDb });
  if (wantLint) await doLintHooks(out, { homeDir: deps.homeDir });
}
