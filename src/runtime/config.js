import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from './data-store.js';

export async function readConfig() {
  const p = paths.data.config();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch (e) {
    throw new Error(`malformed ${p}: ${e.message}`);
  }
}

export async function writeConfig(cfg) {
  const p = paths.data.config();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o644 });
  renameSync(tmp, p);
  chmodSync(p, 0o644);
}
