import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function paths() {
  const home = process.env.ROBIN_HOME || join(homedir(), '.robin');
  return {
    home,
    db: join(home, 'db'),
    models: join(home, 'models'),
    logs: join(home, 'logs'),
    backup: join(home, 'backup'),
    lock: join(home, '.lock'),
  };
}

export async function ensureHome() {
  const p = paths();
  for (const dir of [p.home, p.db, p.models, p.logs, p.backup]) {
    await mkdir(dir, { recursive: true });
  }
}
