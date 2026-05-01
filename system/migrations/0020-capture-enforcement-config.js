// Migration 0020: add memory.capture_enforcement defaults to robin.config.json.
//
// Idempotent: existing capture_enforcement block (any content) is preserved.
// Reversible: delete the capture_enforcement key.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0020-capture-enforcement-config';
export const description = 'Add memory.capture_enforcement defaults to robin.config.json';

export async function up({ workspaceDir }) {
  const file = join(workspaceDir, 'user-data/robin.config.json');
  if (!existsSync(file)) {
    console.log(`[${id}] user-data/robin.config.json not found — no-op`);
    return;
  }
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  cfg.memory ??= {};
  if (cfg.memory.capture_enforcement) {
    console.log(`[${id}] capture_enforcement already set — no-op`);
    return;
  }
  cfg.memory.capture_enforcement = {
    enabled: true,
    min_user_words_tier2: 5,
    min_user_words_tier3: 20,
    retry_budget: 1,
  };
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`[${id}] added memory.capture_enforcement defaults`);
}
