// Project-scoped Bash discretion bypass.
//
// When the Claude Code PreToolUse Bash hook reports a `cwd` inside one of the
// configured project roots, the discretion handler skips every rule in
// `bash-patterns.js` (env-dump, secrets-read, destructive-rm, low-level-fs,
// git-expose-userdata, eval-injection, db-direct-access).
//
// Configured via `ROBIN_BYPASS_PROJECT_PATHS` — colon-separated absolute
// paths (e.g. `/Users/me/workspace/proj-a:/Users/me/code/proj-b`). Default
// is empty: defense-in-depth applies everywhere unless the user opts out.
// The hook re-imports this module on each fire, so updates to the env var
// take effect on the next tool call without a daemon restart.

import { resolve, sep } from 'node:path';

function parseBypassPaths(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw
    .split(':')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => resolve(p));
}

export function getBypassPaths() {
  return parseBypassPaths(process.env.ROBIN_BYPASS_PROJECT_PATHS);
}

export function isCwdBypassed(cwd, paths = getBypassPaths()) {
  if (typeof cwd !== 'string' || cwd.length === 0) return false;
  const normalized = resolve(cwd);
  for (const root of paths) {
    if (normalized === root) return true;
    // Require a directory separator to avoid `/foo/leadforge` matching
    // siblings like `/foo/leadforge-archive`.
    if (normalized.startsWith(root + sep)) return true;
  }
  return false;
}
