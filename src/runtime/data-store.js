import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function packageRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== '/') {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('cannot resolve package root from src/runtime/data-store.js');
}

export function robinHome() {
  if (process.env.ROBIN_HOME) return resolve(process.env.ROBIN_HOME);
  return join(packageRoot(), 'user-data');
}

export function paths() {
  const home = robinHome();
  return {
    home,
    db: join(home, 'db'),
    secrets: join(home, 'secrets'),
    cache: join(home, 'cache'),
    config: join(home, 'config.json'),
    backup: join(home, 'backup'),
    daemonState: join(home, '.daemon.state'),
    daemonLock: join(home, '.daemon.lock'),
    migrationsDir: join(packageRoot(), 'src', 'schema', 'migrations'),
  };
}

export async function ensureHome() {
  const p = paths();
  for (const dir of [p.home, p.db, p.secrets, p.cache, p.backup]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function packageRootDir() {
  return packageRoot();
}
