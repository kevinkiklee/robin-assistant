// Default `robin doctor` (no flags) status renderer and the host-integrations
// drift inspector (doctorData). Both are read-only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDaemonState } from '../../../config/daemon-state.js';
import {
  paths,
  readHostIntegrations,
  readPointer,
  robinHome,
} from '../../../config/data-store.js';
import { defaultDbUrl } from '../../../data/db/client.js';
import { isPidAlive } from '../../daemon/lock.js';
import {
  probeBetterSqlite3,
  probeBiographerLog,
  probeIntegrationFreshness,
  probeLayout,
  probePort,
  probeSupervisor,
  probeSurreal,
} from './_doctor-probes.js';

export async function doStatus(out, deps = {}) {
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

  // Surreal server health probe (only meaningful for ws/wss DB URLs).
  try {
    const dbUrl = await defaultDbUrl();
    if (/^wss?:\/\//.test(dbUrl)) {
      const httpUrl = dbUrl.replace(/^ws/, 'http');
      const surreal = await (deps.probeSurreal ?? probeSurreal)(httpUrl);
      out(`surreal server: ${surreal.message}`);
    }
  } catch {
    // surreal check is supplementary; never fail doctor over it
  }

  // Engine check — config vs on-disk format drift.
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

  const sqlite = await (deps.probeBetterSqlite3 ?? probeBetterSqlite3)();
  out(sqlite.message);
  for (const d of sqlite.details ?? []) out(`  ${d}`);

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

  const sup = (deps.probeSupervisor ?? probeSupervisor)();
  out(`supervisor: ${sup.status}${sup.detail ? ` (${sup.detail})` : ''}`);

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
