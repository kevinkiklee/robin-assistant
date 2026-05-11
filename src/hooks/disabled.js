import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, writeConfig } from '../runtime/config.js';
import { paths } from '../runtime/data-store.js';

/**
 * Return true if hooks are globally disabled (config.json hooks.disabled === true).
 *
 * The `phase` parameter is accepted for call-site compatibility but the check
 * is global — when disabled, ALL phases are suppressed.
 */
export async function isHookDisabled(_phase) {
  const cfg = await readConfig();
  return cfg?.hooks?.disabled === true;
}

/**
 * Disable all hooks by setting config.json hooks.disabled = true.
 *
 * The `phase` parameter is accepted for call-site compatibility.
 */
export async function addDisabled(_phase) {
  const cfg = (await readConfig()) ?? {};
  cfg.hooks = { ...(cfg.hooks ?? {}), disabled: true };
  await writeConfig(cfg);
}

/**
 * Re-enable hooks by setting config.json hooks.disabled = false.
 *
 * The `phase` parameter is accepted for call-site compatibility.
 */
export async function removeDisabled(_phase) {
  const cfg = (await readConfig()) ?? {};
  cfg.hooks = { ...(cfg.hooks ?? {}), disabled: false };
  await writeConfig(cfg);
}

// One-shot migration helper used by ensureHome() in data-store.js.
export function migrateHooksDisabledFlag(home) {
  const flagPath = join(home, 'hooks-disabled.txt');
  return existsSync(flagPath) ? readFileSync(flagPath, 'utf8') : null;
}
