// Resolves the robin workspace root.
//
// Two-tier strategy:
// 1. `ROBIN_WORKSPACE` env var, set by the job runner — covers all scheduled
//    invocations and avoids any filesystem walk.
// 2. Marker walk: walk up from the caller's `import.meta.url` looking for
//    `bin/robin.js`. Robust to scripts being moved between subdirectories
//    (e.g. the `user-data/scripts/` → `user-data/runtime/scripts/` rename).
//
// Replaces the previous `fileURLToPath(new URL('../..', import.meta.url))`
// idiom, which broke silently whenever script depth changed.
//
// Path-builders throughout the codebase prepend `user-data/` to a workspace
// dir (see `system/scripts/sync/lib/cursor.js`, memory paths, job state, etc.).
// If the workspace dir resolves to a path *inside* `user-data/` instead of the
// package root, every path doubles up and writes land at
// `<root>/user-data/user-data/...`. We had a real incident from running a CLI
// from inside `user-data/` with `ROBIN_WORKSPACE` unset; `resolveCliWorkspaceDir`
// now refuses that case loudly instead of silently corrupting state.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function findMarkerUp(startDir) {
  let dir = resolve(startDir);
  while (dir !== '/' && dir !== dirname(dir)) {
    if (existsSync(join(dir, 'bin/robin.js'))) return dir;
    dir = dirname(dir);
  }
  if (existsSync(join(dir, 'bin/robin.js'))) return dir;
  return null;
}

// Validate that `candidate` is a robin workspace root. Throws with a helpful
// message that includes the detected real root (if any) so the user can fix
// their env or cwd. Never silently normalizes — silent normalization can hide
// other bugs.
export function validateWorkspaceRoot(candidate, source) {
  const resolved = resolve(candidate);
  if (existsSync(join(resolved, 'bin/robin.js'))) return resolved;
  const root = findMarkerUp(resolved);
  if (root) {
    throw new Error(
      `${source} resolved to "${resolved}" which is not a robin workspace root. ` +
        `The workspace root is "${root}" (it contains bin/robin.js). ` +
        `Set ROBIN_WORKSPACE="${root}" or run from that directory.`
    );
  }
  throw new Error(
    `${source} resolved to "${resolved}" which is not inside a robin workspace ` +
      `(no bin/robin.js found by walking upward).`
  );
}

export function resolveWorkspaceDir(importMetaUrl) {
  if (process.env.ROBIN_WORKSPACE) {
    return validateWorkspaceRoot(process.env.ROBIN_WORKSPACE, 'ROBIN_WORKSPACE');
  }
  let dir = dirname(fileURLToPath(importMetaUrl));
  // POSIX root sentinel; on Windows `dirname` eventually returns the drive root which equals itself.
  while (dir !== '/' && dir !== dirname(dir)) {
    if (existsSync(join(dir, 'bin/robin.js'))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Cannot locate robin workspace root from ${importMetaUrl}`);
}

// For CLI entry points that previously did `process.env.ROBIN_WORKSPACE || process.cwd()`.
// Validates either source so a misconfigured env or a wrong cwd fails loudly
// instead of producing nested `user-data/user-data/...` paths.
export function resolveCliWorkspaceDir() {
  const source = process.env.ROBIN_WORKSPACE ? 'ROBIN_WORKSPACE' : 'process.cwd()';
  const candidate = process.env.ROBIN_WORKSPACE || process.cwd();
  return validateWorkspaceRoot(candidate, source);
}
