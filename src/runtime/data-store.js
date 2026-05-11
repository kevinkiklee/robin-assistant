import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function findPackageRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== '/') {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('cannot resolve package root from src/runtime/data-store.js');
}

const _packageRoot = findPackageRoot();

export function packageRootDir() {
  return _packageRoot;
}

export const POINTER_VERSION = 1;

function pointerFilePath() {
  return join(_packageRoot, '.robin-home');
}

export function resolveHomeStrict({ pointerPath = pointerFilePath() } = {}) {
  if (process.env.ROBIN_HOME) {
    const p = resolve(process.env.ROBIN_HOME);
    if (!existsSync(p)) {
      throw new Error(
        `$ROBIN_HOME=${p} is set but the path does not exist. Create it or unset $ROBIN_HOME.`,
      );
    }
    return p;
  }
  if (!existsSync(pointerPath)) {
    throw new Error('Robin is not installed. Run: robin install');
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(pointerPath, 'utf8'));
  } catch (e) {
    throw new Error(`malformed ${pointerPath}: ${e.message}`);
  }
  if (parsed?.version !== POINTER_VERSION) {
    throw new Error(
      `.robin-home version ${parsed?.version} is not supported (expected ${POINTER_VERSION}). ` +
        'Run: robin install',
    );
  }
  const target = typeof parsed.home === 'string' ? resolve(parsed.home) : null;
  if (!target || !existsSync(target)) {
    throw new Error(
      `user-data path ${target ?? '(unset)'} recorded in .robin-home is missing. ` +
        'Run: robin install --relocate',
    );
  }
  return target;
}

export function writePointer({ home, installedBy }) {
  const payload = {
    version: POINTER_VERSION,
    home: resolve(home),
    installedAt: new Date().toISOString(),
    installedBy: installedBy ?? 'unknown',
  };
  const p = pointerFilePath();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
  renameSync(tmp, p);
}

export function deletePointer() {
  const p = pointerFilePath();
  if (existsSync(p)) unlinkSync(p);
}

export function pointerExists() {
  return existsSync(pointerFilePath());
}

export function readPointer() {
  const p = pointerFilePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function robinHome() {
  // LEGACY: this fallback is removed in Task 12.1 once install writes .robin-home.
  // Keeping it here so the test suite (which calls into commands that need a
  // home) keeps working while we layer in the new pieces.
  try {
    return resolveHomeStrict();
  } catch {
    if (process.env.ROBIN_HOME) return resolve(process.env.ROBIN_HOME);
    return join(_packageRoot, 'user-data');
  }
}

export const paths = {
  data: {
    home: () => robinHome(),
    db: () => join(robinHome(), 'db'),
    secrets: () => join(robinHome(), 'secrets'),
    cache: () => join(robinHome(), 'cache'),
    logs: () => join(robinHome(), 'cache', 'logs'),
    backup: () => join(robinHome(), 'backup'),
    upload: () => join(robinHome(), 'upload'),
    config: () => join(robinHome(), 'config.json'),
    hostIntegrations: () => join(robinHome(), 'host-integrations.json'),
    daemonState: () => join(robinHome(), '.daemon.state'),
    daemonLock: () => join(robinHome(), '.daemon.lock'),
    manifestLock: () => join(robinHome(), '.manifest.lock'),
    marker: () => join(robinHome(), '.robin-data'),
  },
  source: {
    migrations: () => join(_packageRoot, 'src', 'schema', 'migrations'),
    hookShim: () => join(_packageRoot, 'bin', 'robin-hook.sh'),
    robinBin: () => join(_packageRoot, 'bin', 'robin'),
  },
};

const MARKER_VERSION = 1;

export async function ensureHome() {
  const home = robinHome();
  for (const dir of [
    home,
    paths.data.db(),
    paths.data.secrets(),
    paths.data.cache(),
    paths.data.logs(),
    paths.data.backup(),
    paths.data.upload(),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  const markerPath = paths.data.marker();
  if (!existsSync(markerPath)) {
    const payload = { version: MARKER_VERSION, createdAt: new Date().toISOString() };
    writeFileSync(markerPath, JSON.stringify(payload, null, 2), { mode: 0o644 });
  }
}

export function readMarker() {
  const p = paths.data.marker();
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}
