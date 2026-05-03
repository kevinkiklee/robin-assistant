// Migration 0026: add `optimize` config block to robin.config.json.
//
// Phase 2 of the cost-and-latency optimization rollout adds an `optimize`
// block to user-data/runtime/config/robin.config.json. The block holds
// per-feature toggles for opt-in optimizations like subagent dispatch.
//
// Default values:
//   optimize.subagent_dispatch = "off"
//
// Possible values for subagent_dispatch:
//   "off"                  — all protocols run inline (status quo)
//   "read-only-protocols"  — only protocols that don't write memory dispatch
//                            as subagents (lint, todo-extraction)
//   "all-side-quest"       — all protocols with `dispatch: subagent` in their
//                            frontmatter dispatch as subagents
//
// Idempotent: if the `optimize` block already exists, the migration is a
// no-op. If only specific keys are missing, they're added with defaults.
//
// Atomic write via tmp + rename.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0026-add-optimize-config';
export const description =
  'Add `optimize` block (cost/latency toggles, default off) to user-data/runtime/config/robin.config.json. Phase 2 of cost-and-latency optimization.';

const DEFAULT_OPTIMIZE = {
  $comment: 'Cost/latency optimization toggles. Default off — flip to opt in. Each toggle is reversible without code changes.',
  subagent_dispatch: 'off',
};

export async function up({ workspaceDir }) {
  const configPath = join(workspaceDir, 'user-data', 'runtime', 'config', 'robin.config.json');
  if (!existsSync(configPath)) {
    console.log(`[${id}] ${configPath} not found — no-op`);
    return;
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`[${id}] failed to parse ${configPath}: ${e.message}`);
    throw e;
  }

  if (config.optimize && typeof config.optimize === 'object') {
    let added = 0;
    for (const [k, v] of Object.entries(DEFAULT_OPTIMIZE)) {
      if (!(k in config.optimize)) {
        config.optimize[k] = v;
        added++;
      }
    }
    if (added === 0) {
      console.log(`[${id}] optimize block already present and complete — no-op`);
      return;
    }
    console.log(`[${id}] backfilled ${added} missing key(s) in optimize block`);
  } else {
    config.optimize = { ...DEFAULT_OPTIMIZE };
    console.log(`[${id}] added optimize block with defaults`);
  }

  const tmpPath = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n');
  renameSync(tmpPath, configPath);
}
