// Migration 0024: drop the `platform` field from robin.config.json.
//
// Robin v5.0.0 supports Claude Code only. The `platform` field (which
// previously selected one of claude-code | cursor | gemini-cli | codex |
// antigravity) is no longer read by anything and is removed for cleanliness.
//
// Idempotent. No-op if the field is already absent or the config file is
// missing. Atomic write via tmp + rename. Reversible by hand-adding the
// field back if needed (no code path will read it again).

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0024-drop-platform-field';
export const description =
  'Remove the `platform` field from user-data/runtime/config/robin.config.json (single-host v5).';

export async function up({ workspaceDir }) {
  const cfgPath = join(workspaceDir, 'user-data', 'runtime', 'config', 'robin.config.json');
  if (!existsSync(cfgPath)) {
    console.log(`[${id}] ${cfgPath} not found — no-op`);
    return;
  }

  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch (err) {
    console.warn(`[${id}] config unreadable (${err.message}) — no-op`);
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(cfg, 'platform')) {
    console.log(`[${id}] platform field absent — no-op`);
    return;
  }

  delete cfg.platform;

  const tmp = `${cfgPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  renameSync(tmp, cfgPath);

  console.log(`[${id}] removed platform field from ${cfgPath}`);
}
