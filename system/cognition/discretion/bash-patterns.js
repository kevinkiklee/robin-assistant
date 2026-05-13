// Bash sensitive-pattern matchers. PreToolUse Bash hook invokes
// checkBashCommand(cmd) and refuses (exit 2) on first match.
//
// Defense-in-depth — patterns aim for high-confidence matches; encoded
// payloads (base64 | bash) and aliased binaries fall through and are
// addressed at the secrets-containment layer.
//
// Lifted from Robin v1 (system/runtime/scripts/lib/bash-sensitive-patterns.js)
// with v2 refresh per Phase 4a §5.A:
//   - DROPPED `misrouted-write` (no canonical user-data/artifacts/upload/
//     paths in v2 — DB is the writable surface; DB snapshots now live at
//     `user-data/data/snapshots/` and the legacy `user-data/backup/` is gone).
//   - KEPT `secrets-read`, `env-dump`, `destructive-rm`, `low-level-fs`,
//     `git-expose-userdata`, `eval-injection`.
//   - REFRESHED `secrets-read` regex: v1 referenced
//     `user-data/(?:runtime/|ops/)?secrets/`; v2 path is
//     `user-data/config/secrets/`. The regex matches both the new
//     `user-data/config/secrets/` location and the legacy `user-data/secrets/`
//     literal so any stale tooling/migrations referring to the old path are
//     still gated.
//   - ADDED `db-direct-access` — refuse `surreal sql/connect/import/export`
//     against the local Robin DB. Only the daemon may touch it.

export const BASH_DENY_PATTERNS = [
  {
    name: 'secrets-read',
    pattern:
      /(?:^|[\s|;&])(?:cat|less|more|head|tail|grep|awk|sed|cp|mv|tar|zip|rsync)\s+[^|;&]*(?:user-data\/(?:config\/)?secrets\/|\.env\b)/,
    why: 'Reads secrets file or .env',
  },
  {
    name: 'env-dump',
    pattern: /(?:^|[\s|;&])(?:env|printenv)(?:\s|$|\|)/,
    why: 'Dumps environment variables',
  },
  {
    name: 'destructive-rm',
    pattern:
      /(?:^|[\s|;&])rm\s+-[a-zA-Z]*[rR][a-zA-Z]*[fF]|(?:^|[\s|;&])rm\s+-[a-zA-Z]*[fF][a-zA-Z]*[rR]|(?:^|[\s|;&])rm\s+--recursive\s+--force|(?:^|[\s|;&])rm\s+--force\s+--recursive/,
    why: 'Recursive force delete',
  },
  {
    name: 'low-level-fs',
    pattern: /(?:^|[\s|;&])(?:dd|mkfs(?:\.\w+)?|format|shred|fdisk|wipefs)(?:\s|$)/,
    why: 'Low-level filesystem operations',
  },
  {
    name: 'git-expose-userdata',
    pattern: /git\s+(?:log|show|stash\s+show|diff)\s+[^|;&]*\buser-data\//,
    why: 'Git operation exposing user-data content',
  },
  {
    name: 'eval-injection',
    pattern: /(?:^|[\s|;&])eval\s+[^|;&]|(?:^|[\s|;&])eval\s*\(|\$\(\s*\$\(/,
    why: 'Eval or nested-substitution injection',
  },
  {
    // surreal CLI invocations against the local Robin DB. Only the daemon
    // may touch <robinHome>/data/db. We catch the surreal binary name
    // (allowing path prefixes like `/usr/local/bin/surreal`) followed by a
    // mutating or connecting subcommand, with the local DB path appearing
    // somewhere in the same simple-command segment (no pipe/semicolon/&&
    // between). The v2 canonical path is `user-data/data/db/`; the legacy
    // `user-data/db/` literal is also matched so older tooling/scripts that
    // still reference the pre-redesign location are gated too.
    name: 'db-direct-access',
    pattern:
      /(?:^|[\s|;&])(?:[\w./-]*\/)?surreal\s+(?:sql|connect|import|export)\b[^|;&]*(?:user-data\/(?:data\/)?db\/|\$ROBIN_HOME\/(?:data\/)?db\/|\$\{ROBIN_HOME\}\/(?:data\/)?db\/|\.robin\/db\/)/i,
    why: 'Direct surreal CLI access to local Robin DB; only the daemon may touch it',
  },
];

export function checkBashCommand(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) {
    return { blocked: false };
  }
  for (const rule of BASH_DENY_PATTERNS) {
    if (rule.pattern.test(cmd)) {
      return { blocked: true, name: rule.name, why: rule.why };
    }
  }
  return { blocked: false };
}
