import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, writeConfig } from '../../config/paths.js';

// Per-phase kill-switch storage in `<robinHome>/config.json`:
//
//   { hooks: { disabled: ['discretion', 'intuition'] } }
//
// An empty array means no phases are disabled. Backward compatibility:
//   - `disabled === true`  → treated as "every phase disabled"
//   - `disabled === false` → treated as "no phases disabled"
// Both legacy shapes are normalized to an array on the next write.

const ALL_PHASES = ['discretion', 'intuition', 'session-start', 'stop'];

function normalize(raw) {
  if (Array.isArray(raw)) return raw.filter((s) => typeof s === 'string');
  if (raw === true) return [...ALL_PHASES];
  return [];
}

export async function isHookDisabled(phase) {
  const cfg = await readConfig();
  const list = normalize(cfg?.hooks?.disabled);
  return list.includes(phase);
}

export async function addDisabled(phase) {
  const cfg = (await readConfig()) ?? {};
  const list = normalize(cfg.hooks?.disabled);
  if (!list.includes(phase)) list.push(phase);
  cfg.hooks = { ...(cfg.hooks ?? {}), disabled: list };
  await writeConfig(cfg);
}

export async function removeDisabled(phase) {
  const cfg = (await readConfig()) ?? {};
  const list = normalize(cfg.hooks?.disabled).filter((p) => p !== phase);
  cfg.hooks = { ...(cfg.hooks ?? {}), disabled: list };
  await writeConfig(cfg);
}

// One-shot migration helper used by ensureHome() in data-store.js. Parses
// the legacy newline-separated phase list (with `#` line comments). Returns
// an array of phase names; empty array if the file is empty or absent.
export function migrateHooksDisabledFlag(home) {
  const flagPath = join(home, 'hooks-disabled.txt');
  if (!existsSync(flagPath)) return [];
  const raw = readFileSync(flagPath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0);
}
