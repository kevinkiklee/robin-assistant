// Migration 0022: rename user-data/ops/ to user-data/runtime/.
//
// Idempotent: no-op if user-data/ops/ doesn't exist.
// Reversible via down().

import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0022-rename-ops-to-runtime';
export const description = 'Rename user-data/ops/ to user-data/runtime/.';

export async function up({ workspaceDir }) {
  const ops = join(workspaceDir, 'user-data/ops');
  const runtime = join(workspaceDir, 'user-data/runtime');

  if (!existsSync(ops)) {
    console.log(`[${id}] user-data/ops/ does not exist — no-op`);
    return;
  }
  if (existsSync(runtime)) {
    // If both exist, that's a corrupted state — refuse rather than merge.
    throw new Error(
      `[${id}] both user-data/ops/ and user-data/runtime/ exist; manual reconciliation required`,
    );
  }

  renameSync(ops, runtime);
  console.log(`[${id}] renamed user-data/ops/ → user-data/runtime/`);
}

export async function down({ workspaceDir }) {
  const ops = join(workspaceDir, 'user-data/ops');
  const runtime = join(workspaceDir, 'user-data/runtime');

  if (!existsSync(runtime)) {
    console.log(`[${id}] user-data/runtime/ does not exist — no-op`);
    return;
  }
  if (existsSync(ops)) {
    throw new Error(
      `[${id}] both user-data/ops/ and user-data/runtime/ exist; manual reconciliation required`,
    );
  }

  renameSync(runtime, ops);
  console.log(`[${id}] renamed user-data/runtime/ → user-data/ops/`);
}
