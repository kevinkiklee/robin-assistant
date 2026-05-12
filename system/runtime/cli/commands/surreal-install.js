import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { paths, recordHostTouchpoint, robinHome } from '../../../config/data-store.js';
import { generateSurrealPlist } from '../../install/surreal-plist.js';
import { generateSurrealUnit } from '../../install/surreal-unit.js';
import { surrealEnsureRunning } from './surreal-ensure-running.js';

export const DEFAULT_BIND = '127.0.0.1:8000';
export const DEFAULT_USER = 'root';
export const DEFAULT_PASS = 'root';
export const DEFAULT_STORAGE = 'surrealkv';

function whichSurreal(spawnSyncFn) {
  const finder = platform() === 'win32' ? 'where' : 'which';
  const r = spawnSyncFn(finder, ['surreal'], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  return r.stdout.trim().split(/\r?\n/)[0] || null;
}

function autoSuperviseSurreal(plistPath, _unitPath, spawnSyncFn) {
  if (platform() === 'darwin') {
    spawnSyncFn('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    const load = spawnSyncFn('launchctl', ['load', plistPath], { stdio: 'inherit' });
    if (load.status === 0) {
      console.log('launchd: surreal loaded — server will be restarted on crash');
    } else {
      console.log('launchd: surreal load failed (non-fatal); run manually:');
      console.log(`  launchctl load ${plistPath}`);
    }
  } else if (platform() === 'linux') {
    const reload = spawnSyncFn('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    const enable = spawnSyncFn(
      'systemctl',
      ['--user', 'enable', '--now', 'robin-surreal.service'],
      { stdio: 'inherit' },
    );
    if (reload.status === 0 && enable.status === 0) {
      console.log('systemd: surreal enabled — server will be restarted on crash');
    } else {
      console.log('systemd: surreal enable failed (non-fatal); run manually:');
      console.log('  systemctl --user daemon-reload');
      console.log('  systemctl --user enable --now robin-surreal.service');
    }
  }
}

/**
 * Install + auto-start the standalone SurrealDB server.
 *
 * Side effects:
 *   - Writes a launchd plist (macOS) or systemd user unit (Linux) and
 *     records it in host-integrations.json so `robin uninstall` can clean
 *     it up.
 *   - Loads the supervisor (launchctl load / systemctl enable --now), which
 *     starts the surreal process.
 *   - Polls the server's /health endpoint until ready.
 *
 * Returns the connection params the caller should persist in config.json
 * so all Robin processes (daemon, biographer, CLI) connect via ws:// and
 * share the server's lock-free multi-writer arbitration.
 *
 * @param {{
 *   bind?: string,
 *   user?: string,
 *   pass?: string,
 *   storage?: string,
 *   spawnSync?: typeof spawnSync,
 *   fetchFn?: typeof globalThis.fetch,
 *   which?: (spawnSyncFn: typeof spawnSync) => string | null,
 *   readyTimeoutMs?: number,
 * }} opts
 * @returns {Promise<{ url: string, user: string, pass: string }>}
 */
export async function surrealInstall({
  bind = DEFAULT_BIND,
  user = DEFAULT_USER,
  pass = DEFAULT_PASS,
  storage = DEFAULT_STORAGE,
  spawnSync: spawnSyncFn = spawnSync,
  fetchFn = globalThis.fetch,
  which = whichSurreal,
  readyTimeoutMs = 30000,
} = {}) {
  const surrealBin = which(spawnSyncFn);
  if (!surrealBin) {
    console.error("'surreal' binary not found on PATH.");
    console.error('Install SurrealDB:');
    console.error('  brew install surrealdb/tap/surreal      # macOS');
    console.error('  curl -sSf https://install.surrealdb.com | sh   # Linux');
    console.error('Then re-run `robin install`.');
    process.exit(1);
  }

  const dbDir = paths.data.db();
  await mkdir(dbDir, { recursive: true });
  const logsDir = paths.data.logs();
  await mkdir(logsDir, { recursive: true });
  const logPath = join(logsDir, 'surreal.log');
  const home = robinHome();

  let plistPath = null;
  let unitPath = null;

  if (platform() === 'darwin') {
    const plistDir = join(homedir(), 'Library/LaunchAgents');
    await mkdir(plistDir, { recursive: true });
    plistPath = join(plistDir, 'io.robin-assistant.surreal.plist');
    const xml = generateSurrealPlist({
      surrealBin,
      bind,
      user,
      pass,
      storage,
      dbDir,
      logPath,
    });
    await recordHostTouchpoint(
      {
        kind: 'launchd-plist',
        path: plistPath,
        expectedHome: home,
        label: 'io.robin-assistant.surreal',
      },
      () => writeFileSync(plistPath, xml, { mode: 0o644 }),
    );
    console.log(`installed launchd plist: ${plistPath}`);
  } else if (platform() === 'linux') {
    const unitDir = join(homedir(), '.config/systemd/user');
    await mkdir(unitDir, { recursive: true });
    unitPath = join(unitDir, 'robin-surreal.service');
    const txt = generateSurrealUnit({
      surrealBin,
      bind,
      user,
      pass,
      storage,
      dbDir,
      logPath,
    });
    await recordHostTouchpoint(
      {
        kind: 'systemd-unit',
        path: unitPath,
        expectedHome: home,
        label: 'robin-surreal.service',
      },
      () => writeFileSync(unitPath, txt, { mode: 0o644 }),
    );
    console.log(`installed systemd user unit: ${unitPath}`);
  } else {
    console.error(`platform ${platform()} not supported; surreal supervision unavailable`);
    process.exit(1);
  }

  autoSuperviseSurreal(plistPath, unitPath, spawnSyncFn);

  console.log(`Waiting for SurrealDB server at ${bind}…`);
  const ready = await surrealEnsureRunning({ bind, timeoutMs: readyTimeoutMs, fetchFn });
  if (!ready) {
    console.error(
      `SurrealDB server failed to become ready at ${bind} within ${Math.round(readyTimeoutMs / 1000)}s.`,
    );
    console.error(`Check ${logPath} for errors.`);
    process.exit(1);
  }
  console.log(`SurrealDB server ready at ws://${bind}`);

  return { url: `ws://${bind}`, user, pass };
}
