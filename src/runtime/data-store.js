import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export function robinHome() {
  // TEMPORARY: keep the old default behavior in this task; strict resolver
  // lands in Task 1.4. Maintains green tests during the split refactor.
  if (process.env.ROBIN_HOME) return resolve(process.env.ROBIN_HOME);
  return join(_packageRoot, 'user-data');
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
