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
  // 0600: config.json now contains the surreal db credentials (`db.pass`)
  // alongside embedder_profile and other settings. Loopback binding limits
  // network exposure; this stops other local users from reading the password.
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}
