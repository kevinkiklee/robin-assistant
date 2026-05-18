// Default `robin doctor` (no flags) status renderer and the host-integrations
// drift inspector (doctorData). Both are read-only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDaemonState } from '../../../config/daemon-state.js';
import { paths, readHostIntegrations, readPointer, robinHome } from '../../../config/data-store.js';
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

// ANSI color helpers. `colors` boolean is computed by the caller from
// `process.stdout.isTTY && !process.env.NO_COLOR && !args.includes('--json')`.
// Tests pass `colors:true` explicitly to assert the wrapping happens — they
// run without a TTY, so the dispatcher's gating logic collapses to false in
// the test env and never flakes on a real terminal.
const ANSI = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
};

// Compact relative-time formatter for the `(daemon-evaluated Nm ago)`
// annotation on invariants that fell back to the daemon's heartbeat verdict.
// Stays integer-coarse so the rendered line is stable across runs separated
// by a few ms.
function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function colorize(s, status, colors) {
  if (!colors) return s;
  if (status === 'ok') return `${ANSI.green}${s}${ANSI.reset}`;
  if (status === 'warn') return `${ANSI.yellow}${s}${ANSI.reset}`;
  if (status === 'fail') return `${ANSI.red}${s}${ANSI.reset}`;
  return s;
}

/**
 * Render the invariant-runner report as a realm-grouped, one-screen status
 * summary. Each result has `{ name, surface, status: 'ok'|'warn'|'fail',
 * error?, remediation?, lastPassedTs? }`. Returns a single string ready to print.
 *
 * - Realm = `surface`. Iteration order is the first-seen order of `results`.
 * - Each realm gets a one-line header: `<realm> <status> N check(s)[ (X warn, Y fail)]`.
 * - Per warn / fail check renders an inline sigil line + indented remediation steps.
 * - When `verbose: true`, every check (including `ok`) gets a `    last_passed: <iso|never>`
 *   provenance line under it.
 * - When `colors: true`, realm-status tokens and per-check sigils are wrapped in
 *   ANSI escape codes (green ok / yellow warn / red fail).
 * - Final `Summary:` line counts across all realms and emits `Exit 0` (no
 *   fails) or `Exit 1` (any fail) so the caller can `process.exit(...)` off it.
 */
export function renderDoctor({ results = [], ts, verbose = false, colors = false } = {}) {
  const lines = [`Robin doctor — ${ts ?? new Date().toISOString()}`, ''];
  const byRealm = new Map();
  for (const r of results) {
    const realm = r.surface ?? 'other';
    if (!byRealm.has(realm)) byRealm.set(realm, []);
    byRealm.get(realm).push(r);
  }

  let okCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const [realm, items] of byRealm) {
    const warns = items.filter((i) => i.status === 'warn');
    const fails = items.filter((i) => i.status === 'fail');
    const oks = items.filter((i) => i.status === 'ok');

    let realmStatus = 'ok';
    if (fails.length > 0) realmStatus = 'fail';
    else if (warns.length > 0) realmStatus = 'warn';

    const noun = items.length === 1 ? 'check' : 'checks';
    const detailParts = [];
    if (warns.length > 0) detailParts.push(`${warns.length} warn`);
    if (fails.length > 0) detailParts.push(`${fails.length} fail`);
    const detailSuffix = detailParts.length > 0 ? ` (${detailParts.join(', ')})` : '';

    const statusToken = colorize(realmStatus.padEnd(6), realmStatus, colors);
    lines.push(`${realm.padEnd(12)} ${statusToken} ${items.length} ${noun}${detailSuffix}`);

    // In verbose mode, surface `last_passed` provenance for every check (ok + warn + fail),
    // ordered ok → warn → fail so the realm reads top-to-bottom by severity.
    if (verbose) {
      for (const item of oks) {
        const sigil = colorize('✓', 'ok', colors);
        const annotation =
          item.daemonEvaluatedAgoMs != null
            ? ` (daemon-evaluated ${formatAgo(item.daemonEvaluatedAgoMs)})`
            : '';
        lines.push(`  ${sigil} ${item.name}${annotation}`);
        lines.push(`    last_passed: ${item.lastPassedTs ?? 'never'}`);
      }
    }

    for (const item of [...warns, ...fails]) {
      const rawSigil = item.status === 'warn' ? '⚠' : '✖';
      const sigil = colorize(rawSigil, item.status, colors);
      const errText = item.error ? ` — ${item.error}` : '';
      lines.push(`  ${sigil} ${item.name}${errText}`);
      const remediations = Array.isArray(item.remediation)
        ? item.remediation
        : item.remediation
          ? [item.remediation]
          : [];
      for (const rem of remediations) lines.push(`    → ${rem}`);
      if (verbose) lines.push(`    last_passed: ${item.lastPassedTs ?? 'never'}`);
    }

    okCount += oks.length;
    warnCount += warns.length;
    failCount += fails.length;
  }

  lines.push('');
  const exit = failCount > 0 ? 1 : 0;
  lines.push(`Summary: ${okCount} ok, ${warnCount} warn, ${failCount} fail. Exit ${exit}.`);
  return lines.join('\n');
}

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
