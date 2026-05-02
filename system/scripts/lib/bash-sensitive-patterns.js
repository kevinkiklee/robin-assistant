// Bash sensitive-pattern matchers. Cycle-2a: PreToolUse hook for Bash
// invokes checkBashCommand(cmd) and refuses (exit 2) on first match.
// Defense-in-depth — patterns aim for high-confidence matches; encoded
// payloads (base64 | bash) and aliased binaries fall through and are
// addressed at the secrets-containment layer (G-22/G-32).

export const SENSITIVE_PATTERNS = [
  {
    name: 'secrets-read',
    pattern: /(?:^|[\s|;&])(?:cat|less|more|head|tail|grep|awk|sed|cp|mv|tar|zip|rsync)\s+[^|;&]*(?:user-data\/(?:runtime\/|ops\/)?secrets\/|\.env\b)/,
    why: 'Reads secrets file or .env',
  },
  {
    name: 'env-dump',
    pattern: /(?:^|[\s|;&])(?:env|printenv)(?:\s|$|\|)/,
    why: 'Dumps environment variables',
  },
  {
    name: 'destructive-rm',
    pattern: /(?:^|[\s|;&])rm\s+-[a-zA-Z]*[rR][a-zA-Z]*[fF]|(?:^|[\s|;&])rm\s+-[a-zA-Z]*[fF][a-zA-Z]*[rR]|(?:^|[\s|;&])rm\s+--recursive\s+--force|(?:^|[\s|;&])rm\s+--force\s+--recursive/,
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
    // Catch writes to bare `artifacts/` or `backup/` at the workspace root.
    // Canonical locations are `user-data/artifacts/` and `user-data/backup/`.
    // Patterns target obvious write contexts:
    //   1. redirects (`> path`, `>> path`, `2> path`, etc.)
    //   2. `mv|cp|tar|rsync|install|mkdir|ln` at command position (start of
    //      string or after shell separators `;` `&`, NOT after a pipe `|`)
    //      with a bare-path argument.
    // The command word must be at command position — not preceded by `|` —
    // so that prose mentioning `mkdir|ln` inside a quoted string (e.g. a
    // git commit message body) does not false-positive.
    name: 'misrouted-write',
    pattern: /(?:(?:^|\s)(?:>>?|2>>?|&>>?)\s*(?:\.\/)?(?:artifacts|backup)\/)|(?:(?:^|[\s;&])(?:mv|cp|tar|rsync|install|mkdir|ln)\s+[^|;&\n]*\s(?:\.\/)?(?:artifacts|backup)\/)/,
    why: 'Writes to bare artifacts/ or backup/ at workspace root — canonical paths are user-data/artifacts/ and user-data/backup/',
  },
];

export function checkBashCommand(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) {
    return { blocked: false };
  }
  for (const rule of SENSITIVE_PATTERNS) {
    if (rule.pattern.test(cmd)) {
      return { blocked: true, name: rule.name, why: rule.why };
    }
  }
  return { blocked: false };
}
