// Special command handlers invoked by `robin doctor --<flag>`:
// rebaseline, purge-stale-sessions, lint-hooks. Each is a distinct operation
// that doesn't fit the framework's check/repair model.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readDaemonState } from '../../../config/daemon-state.js';
import { ensureHome, packageRootDir, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { isPidAlive } from '../../daemon/lock.js';
import { purgeStaleSessions } from '../../daemon/sessions.js';
import { computeManifest, writeManifest } from '../../install/manifest.js';

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

export async function doRebaseline(out) {
  await ensureHome();
  const m = await computeManifest();
  await writeManifest(m);
  out(`introspection baseline rewritten (${m.files.length} files)`);
}

export async function doPurgeStaleSessions(out, err, deps = {}) {
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

export async function doLintHooks(out, { homeDir = homedir() } = {}) {
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
