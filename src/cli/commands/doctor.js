// `robin doctor` — Phase 4a minimal scope (spec §13 open question 5).
//
// Flags:
//   --rebaseline             rewrite <robinHome>/manifest.json from current state
//   --purge-stale-sessions   delete runtime_sessions rows whose status='stale'
//   --lint-hooks             list robin-owned hook entries in
//                            ~/.claude/settings.json + ~/.gemini/settings.json
//
// With NO flags: print a one-fact-per-line status overview.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

async function doStatus(out) {
  const p = paths();
  out(`ROBIN_HOME: ${p.home}`);
  const manifestExists = existsSync(join(p.home, 'manifest.json'));
  out(`manifest: ${manifestExists ? 'present' : 'missing'}`);
  const daemonState = await readDaemonState(p.daemonState);
  if (daemonState && isPidAlive(daemonState.pid)) {
    out(`daemon: running (pid=${daemonState.pid})`);
  } else if (daemonState) {
    out('daemon: stale state file (process not alive)');
  } else {
    out('daemon: not running');
  }
  const secretsEnv = join(p.secrets, '.env');
  out(`secrets file: ${existsSync(secretsEnv) ? 'present' : 'missing'}`);
  const configExists = existsSync(p.config);
  out(`config: ${configExists ? 'present' : 'missing'}`);
}

export async function doctor(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));

  const wantRebaseline = args.flags.rebaseline === true;
  const wantPurge = args.flags['purge-stale-sessions'] === true;
  const wantLint = args.flags['lint-hooks'] === true;

  if (!wantRebaseline && !wantPurge && !wantLint) {
    await doStatus(out);
    return;
  }

  if (wantRebaseline) await doRebaseline(out);
  if (wantPurge)
    await doPurgeStaleSessions(out, err, { openDb: deps.openDb, closeDb: deps.closeDb });
  if (wantLint) await doLintHooks(out, { homeDir: deps.homeDir });
}
