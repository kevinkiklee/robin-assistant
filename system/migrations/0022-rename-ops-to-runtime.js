// Migration 0022: rename user-data/ops/ to user-data/runtime/.
//
// Idempotent: no-op if user-data/ops/ doesn't exist.
// Reversible via down().
//
// Empty-tree handling: preflight's scaffold-sync may create an empty
// user-data/runtime/ tree (mirroring scaffold dirs without files) before
// this migration runs. If the destination contains no actual files —
// only empty directories — we delete it and proceed with the rename.
// If the destination has any files, we refuse (real conflict).

import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0022-rename-ops-to-runtime';
export const description = 'Rename user-data/ops/ to user-data/runtime/.';

function hasAnyFile(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasAnyFile(join(dir, entry.name))) return true;
  }
  return false;
}

function clearEmptyTreeOrThrow(dir, otherDir, side) {
  if (!existsSync(dir)) return;
  if (hasAnyFile(dir)) {
    throw new Error(
      `[${id}] both user-data/ops/ and user-data/runtime/ exist with files in ${side}; manual reconciliation required`,
    );
  }
  rmSync(dir, { recursive: true });
  console.log(`[${id}] cleared empty ${side} tree (likely from preflight scaffold-sync)`);
}

export async function up({ workspaceDir }) {
  const ops = join(workspaceDir, 'user-data/ops');
  const runtime = join(workspaceDir, 'user-data/runtime');

  if (!existsSync(ops)) {
    console.log(`[${id}] user-data/ops/ does not exist — no-op`);
    return;
  }
  clearEmptyTreeOrThrow(runtime, ops, 'runtime/');

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
  clearEmptyTreeOrThrow(ops, runtime, 'ops/');

  renameSync(runtime, ops);
  console.log(`[${id}] renamed user-data/runtime/ → user-data/ops/`);
}
