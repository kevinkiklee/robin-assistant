// Project-scoped Bash discretion bypass.
//
// When the Claude Code PreToolUse Bash hook reports a `cwd` inside one of
// these project roots, the discretion handler skips every rule in
// `bash-patterns.js` (env-dump, secrets-read, destructive-rm, low-level-fs,
// git-expose-userdata, eval-injection, db-direct-access).
//
// Add a path here only for trusted local projects where the loss of
// defense-in-depth is acceptable. Remove an entry to revoke; the next hook
// fire re-imports this module.

import { resolve, sep } from 'node:path';

const RAW_BYPASS_PROJECT_PATHS = ['/Users/iser/workspace/leadforge'];

export const BYPASS_PROJECT_PATHS = RAW_BYPASS_PROJECT_PATHS.map((p) => resolve(p));

export function isCwdBypassed(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return false;
  const normalized = resolve(cwd);
  for (const root of BYPASS_PROJECT_PATHS) {
    if (normalized === root) return true;
    // Require a directory separator to avoid `/foo/leadforge` matching
    // siblings like `/foo/leadforge-archive`.
    if (normalized.startsWith(root + sep)) return true;
  }
  return false;
}
