# Cycle-2a — Secrets Containment + Bash Policy

**Date:** 2026-04-30
**Author:** Kevin (with Claude)
**Status:** Draft — implementation paused (other agent active on package)
**Source audit:** `docs/security/audit-2026-04-30.md` (audit pinned SHA: `b5f413c1ba7c60910a1f2c111b248c1ae6daa9f3`)
**Predecessor cycles:** cycle-1a, cycle-1b (refusal-log infrastructure reused; rename to `policy-refusals.log`).
**Source-audit gap IDs:** G-22, G-29, G-30, G-32
**Acceptance scenarios:** S6 (supply-chain at install reads secrets), S8 (jailbreak amplification via bypassPermissions)

> Note: G-30 originally lived in cycle-2b's "tamper detection" group. Pulled into 2a because addressing G-29 (`bypassPermissions` + `Bash(*)`) properly requires extending the PreToolUse hook to match Bash — which IS G-30. Cycle-2b shrinks to G-28 + G-37.

---

## 1. Goals & non-goals

### Goals
- Prevent secrets in `secrets/.env` from polluting `process.env`. Subprocesses (especially `discord-bot`'s `claude -p` children) must never inherit secrets via env.
- Prevent T4 jailpath from running arbitrary Bash that reads `secrets/.env`, dumps env, or performs destructive operations.
- Pass acceptance scenarios S6 and S8.
- Maintain Kevin's autonomy: zero confirm prompts; sensitive Bash commands block silently with retrospective surface in morning briefing.

### Non-goals
- OS-keychain integration (heavy refactor; portability concern; out of scope).
- Sandboxing every Bash call (defense-in-depth, not a sandbox; document explicitly).
- Defending against base64-encoded or alias-laundered payloads beyond the pattern detection's reach (lazy-read fix is the structural defense for those).
- Removing `bypassPermissions` from `.claude/settings.local.json` (Kevin's intentional autonomy choice; we keep the setting and add a hook-level filter on top).

### Constraints
- Must function alongside the other agent's `feat/a3-session-end-sweep` (Stop-hook session-handoff writes; AGENTS.md "Session End" section). Re-read both before edits.
- Reuses cycle-1b's `outbound-policy.js` refusal-log infrastructure (renamed to `policy-refusals.log`, gains a `kind` column).
- Hook must run in <50ms target / <100ms ceiling per Bash invocation. Hot-path consideration.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Mechanism 1 — Secrets containment                               │
│  1a. requireSecret() reads secrets/.env on demand; never        │
│      writes process.env. loadSecrets() removed.                 │
│  1b. safeEnv() helper builds explicit minimal env for spawn.    │
│      Every spawn/fork/exec site uses it.                        │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ Mechanism 2 — Bash policy hook                                  │
│  2a. .claude/settings.json adds Bash matcher to PreToolUse.     │
│  2b. claude-code-hook.js gains --on-pre-bash mode.              │
│  2c. bash-sensitive-patterns.js: first-match-wins regex set.   │
│  2d. Match → exit 2 + stderr + policy-refusals.log entry.       │
│  2e. Fail-closed: any uncaught error in hook also exits 2.     │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────┐
        │ policy-refusals.log              │
        │ (renamed from cycle-1b's         │
        │  outbound-refusals.log; gains    │
        │  kind column: bash | outbound)   │
        └──────────────────────────────────┘
                       │
                       ▼
        Morning briefing: "Security: policy refusals" section
        groups by kind; flags hook-internal-error separately.
```

---

## 3. Mechanism 1 — Secrets containment

### 3.1 `secrets.js` rewrite

**Current** (`system/scripts/sync/lib/secrets.js`):
- `loadSecrets(workspaceDir)` reads `secrets/.env` and writes every key to `process.env`.
- `requireSecret(key)` reads `process.env[key]`.
- `saveSecret(workspaceDir, key, value)` atomic-writes the file (cycle-3 hotfix added mode 0600).

**After**:
- `loadSecrets()` is **removed**. Importers fail at module load if any caller still calls it; the migration step (§7) audits and removes call sites.
- `requireSecret(workspaceDir, key)` reads `secrets/.env` directly per call. Parses .env (same line-by-line logic that `loadSecrets` used). Throws if missing. Does NOT write `process.env`.
- `saveSecret` unchanged.

**No cache.** Per-call file read is ~1ms on SSD. Secrets are accessed 2-3 times per session in practice (login, OAuth refresh). Caching would defeat the "secrets don't linger in module memory" property. If a future hot path emerges, an opt-in module-level Map cache with a 30-second TTL is the future hardening — not now.

```js
// system/scripts/sync/lib/secrets.js (after)
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';

function envPath(workspaceDir) {
  return join(workspaceDir, 'user-data/secrets/.env');
}

function parseEnv(workspaceDir) {
  const path = envPath(workspaceDir);
  if (!existsSync(path)) return new Map();
  const out = new Map();
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
}

export function requireSecret(workspaceDir, key) {
  if (!workspaceDir) throw new TypeError('requireSecret: workspaceDir is required');
  const value = parseEnv(workspaceDir).get(key);
  if (!value) {
    throw new Error(
      `Missing secret: ${key}. Add it to user-data/secrets/.env (see system/skeleton/secrets/README.md).`
    );
  }
  return value;
}

// saveSecret unchanged from cycle-3 hotfix.
```

### 3.2 `safe-env.js` helper

`system/scripts/lib/safe-env.js`:

```js
const SAFE_ENV_KEYS = [
  'HOME', 'PATH', 'USER', 'LANG', 'TERM', 'TMPDIR', 'NODE_PATH',
  'ROBIN_WORKSPACE', 'ROBIN_AGENT_COMMAND', 'ROBIN_BIN', 'ROBIN_NO_NOTIFY',
];

export function safeEnv(extras = {}) {
  const out = {};
  for (const k of SAFE_ENV_KEYS) {
    if (k in process.env) out[k] = process.env[k];
  }
  return { ...out, ...extras };
}
```

`extras` lets a specific spawn add a vetted env var (e.g., a debug flag) without polluting the default allowlist.

### 3.3 Refactor surface

Direct `process.env.<SECRET>` readers replaced with `requireSecret(workspaceDir, key)`:
- `system/skeleton/scripts/auth-discord.js:26` — `DISCORD_BOT_TOKEN`
- `system/skeleton/scripts/auth-discord.js:61` — `DISCORD_APP_ID`
- `system/skeleton/scripts/discord-bot.js:285` — `DISCORD_BOT_TOKEN`
- `system/skeleton/scripts/discord-bot.js:44` — `DISCORD_ALLOWED_USER_IDS` (PII)
- `system/skeleton/scripts/discord-bot.js:45` — `DISCORD_ALLOWED_GUILD_ID` (PII)

Lines like `discord-bot.js:47-50` (CLAUDE_PATH, TIMEOUT_MS, MAX_TURNS, MAX_CONCURRENT_RUNS) are configuration, not secrets — stay in `process.env`. Same line for `ROBIN_WORKSPACE`, `SPOTIFY_AUTH_PORT`. Rule: anything stored in `secrets/.env` becomes a `requireSecret` call; anything else stays as `process.env`.

OAuth flow already uses `requireSecret(provider.refreshTokenEnv)` etc. via `system/scripts/sync/lib/oauth.js`; that helper continues to work after the rewrite (signature changes from `requireSecret(key)` to `requireSecret(workspaceDir, key)` — caller passes `workspaceDir` through).

### 3.4 Spawn-site updates

Every `spawn`/`fork`/`exec` call site adds `env: safeEnv()`. Sites:
- `system/skeleton/scripts/discord-bot.js` — `claude -p` subprocess
- `system/scripts/hooks/claude-code.js:47` — migrate-auto-memory subprocess
- `system/scripts/jobs/runner.js` — job execution subprocesses
- (Audit during implementation: any other `spawn` call.)

```js
// before
const child = spawn('claude', args, { cwd: workspaceDir, stdio: [...] });

// after
import { safeEnv } from '../../system/scripts/lib/safe-env.js';
const child = spawn('claude', args, { cwd: workspaceDir, env: safeEnv(), stdio: [...] });
```

### 3.5 Worked example — `discord-bot.js` refactor

Before:
```js
import { Client } from 'discord.js';
async function main() {
  const client = new Client({ intents: [...] });
  await client.login(process.env.DISCORD_BOT_TOKEN);
  const userIds = process.env.DISCORD_ALLOWED_USER_IDS.split(',');
  const guildId = process.env.DISCORD_ALLOWED_GUILD_ID;
  // ...
  const child = spawn('claude', args, { cwd: workspaceDir });
}
```

After:
```js
import { Client } from 'discord.js';
import { requireSecret } from '../../system/scripts/sync/lib/secrets.js';
import { safeEnv } from '../../system/scripts/lib/safe-env.js';

const workspaceDir = process.env.ROBIN_WORKSPACE || resolve(__dirname, '../..');

async function main() {
  const client = new Client({ intents: [...] });
  await client.login(requireSecret(workspaceDir, 'DISCORD_BOT_TOKEN'));
  // BOT_TOKEN now lives only in discord.js library's internal state (residual).
  // Not in process.env. Subprocesses can't inherit it.

  const userIds = requireSecret(workspaceDir, 'DISCORD_ALLOWED_USER_IDS').split(',');
  const guildId = requireSecret(workspaceDir, 'DISCORD_ALLOWED_GUILD_ID');
  // ...
  const child = spawn('claude', args, {
    cwd: workspaceDir,
    env: safeEnv(),    // explicit minimal env
  });
}
```

~5 added lines, ~3 changed lines per file. Mechanical refactor.

### 3.6 Residual risks (documented)

- **Parent JS heap.** After `client.login(BOT_TOKEN)`, the discord.js library caches the token in its internal state for reconnects. We can't scrub library-internal heap. Bash cannot read JS heap; this is observable only via debugger access (T3 with active session). Acceptable per threat model.
- **Local variables.** `requireSecret` returns the value; the caller's local variable holds it for the call's lifetime. JIT/GC eventually reclaims it. Same residual as discord.js library state.

---

## 4. Mechanism 2 — Bash policy hook

### 4.1 `.claude/settings.json` extension

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "node system/scripts/hooks/claude-code.js --on-pre-tool-use" }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node system/scripts/hooks/claude-code.js --on-pre-bash" }
        ]
      }
    ],
    "Stop": [ ... unchanged ... ]
  }
}
```

`Bash(*)` stays in `.claude/settings.local.json` `permissions.allow` so routine commands pass with no prompt. The hook runs on every Bash and is the actual policy gate.

### 4.2 `claude-code-hook.js` — `--on-pre-bash` mode

```js
async function onPreBash() {
  try {
    const event = JSON.parse(await readStdin());
    const cmd = event.tool_input?.command ?? event.input?.command ?? '';
    if (!cmd) {
      // No command to inspect — pass through.
      process.exit(0);
    }

    // Lazy import — only loaded when bash-mode is hot.
    const { checkBashCommand } = await import('./lib/bash-sensitive-patterns.js');
    const result = checkBashCommand(cmd);

    if (result.blocked) {
      const { appendPolicyRefusal } = await import('./lib/policy-refusals-log.js');
      appendPolicyRefusal(REPO_ROOT, {
        kind: 'bash',
        target: 'local-bash',
        layer: 'pattern',
        reason: `${result.name}: ${result.why}`,
        contentHash: fnv1a(cmd),
      });
      process.stderr.write(`POLICY_REFUSED [bash:${result.name}]: ${result.why}\n`);
      process.exit(2);
    }

    process.exit(0);
  } catch (err) {
    // FAIL-CLOSED: any uncaught error blocks rather than silently passing through.
    try {
      const { appendPolicyRefusal } = await import('./lib/policy-refusals-log.js');
      appendPolicyRefusal(REPO_ROOT, {
        kind: 'bash',
        target: 'local-bash',
        layer: 'hook-internal-error',
        reason: `HOOK_INTERNAL_ERROR: ${err?.message || String(err)}`,
        contentHash: '',
      });
    } catch { /* logging itself failed; still block */ }
    process.stderr.write(`POLICY_REFUSED [bash:hook-internal-error]: ${err?.message || String(err)}\n`);
    process.exit(2);
  }
}
```

### 4.3 `bash-sensitive-patterns.js`

`system/scripts/lib/bash-sensitive-patterns.js`:

```js
export const SENSITIVE_PATTERNS = [
  {
    name: 'secrets-read',
    pattern: /(?:^|[\s|;&])(?:cat|less|more|head|tail|grep|awk|sed|cp|mv|tar|zip|rsync)\s+[^|;&]*\b(?:user-data\/secrets\/|\.env\b)/,
    why: 'Reads secrets file or .env',
  },
  {
    name: 'env-dump',
    pattern: /(?:^|[\s|;&])(?:env|printenv|set\s+-?o?\s*posix)(?:\s|$|\|)/,
    why: 'Dumps environment variables',
  },
  {
    name: 'destructive-rm',
    pattern: /(?:^|[\s|;&])rm\s+-[a-zA-Z]*r[a-zA-Z]*f|rm\s+-[a-zA-Z]*f[a-zA-Z]*r|rm\s+--recursive\s+--force/,
    why: 'Recursive force delete',
  },
  {
    name: 'low-level-fs',
    pattern: /(?:^|[\s|;&])(?:dd|mkfs|format|shred|fdisk|wipefs)(?:\s|$)/,
    why: 'Low-level filesystem operations',
  },
  {
    name: 'git-expose-userdata',
    pattern: /git\s+(?:log|show|stash\s+show|diff)\s+[^|;&]*\buser-data\//,
    why: 'Git operation exposing user-data content',
  },
  {
    name: 'eval-injection',
    pattern: /\beval\s+[^|;&]|\beval\(|\$\(\s*\$\(/,
    why: 'Eval or nested-substitution injection patterns',
  },
];

export function checkBashCommand(cmd) {
  for (const rule of SENSITIVE_PATTERNS) {
    if (rule.pattern.test(cmd)) return { blocked: true, name: rule.name, why: rule.why };
  }
  return { blocked: false };
}
```

First-match-wins. Patterns aim for high-confidence matches — false positives on legit commands tip the user toward refusal-log review (which is fine) rather than attacker-evasion.

Patterns deliberately exclude `curl`/`wget`/`nc` — too many legitimate uses; cycle-1b's outbound-policy gate handles content-side exfil. **What's sent matters; what's invoked doesn't.**

### 4.4 Performance

- **Hook startup target:** <50ms. <100ms ceiling.
- **Lazy import** of patterns module and policy-refusals-log keeps the non-Bash hook paths (PreToolUse on Write/Edit, Stop) fast.
- **First-match-wins** terminates pattern scan early.
- **Concurrent hooks** are independent processes; refusal-log uses `appendFileSync` which is atomic at the OS level — no race issues.

### 4.5 Known limitations (documented in `system/rules/security.md`)

- **Encoded payloads** — `echo b64 | base64 -d | bash` evades regex; the inner Bash is what runs. Mitigation: lazy-read fix means secrets aren't in env to be dumped; the file is still readable but that's also true with no hook.
- **Aliased binaries** — `alias cat=mv` could redirect; we don't normalize aliases (out of scope; bash doesn't expose alias resolution to the hook).
- **Compound-command first clause** — `rm -rf user-data/ && cat secrets/.env` matches on the second clause; the first runs unchecked. Patterns are per-clause-greedy. The destructive-rm pattern would also catch `rm -rf user-data/`.
- **Pattern lag** — refusal-log review surfaces unblocked commands. New attacks observed → pattern PR. Bounded staleness.

---

## 5. Refusal log evolution

### 5.1 Rename

Cycle-1b's `outbound-refusals.log` → `policy-refusals.log`. Helper module renamed `outbound-log.js` → `policy-refusals-log.js`. Function renamed `appendOutboundRefusal` → `appendPolicyRefusal`.

If cycle-1b ships first, cycle-2a's deployment includes a one-shot rename: move the file, update the writer, no data migration needed (entries are append-only and don't reference each other).

If they land together, just use the new name everywhere from the start.

### 5.2 New schema

```
timestamp \t kind \t target \t layer \t reason \t content-hash
```

Where:
- `kind`: `outbound` (cycle-1b) | `bash` (cycle-2a) | future kinds.
- `target`: tool target string (e.g., `github:owner/repo`, `local-bash`, `discord:dm:USERID`).
- `layer`: `1`/`2`/`3` for cycle-1b outbound-policy layers; `pattern`/`hook-internal-error` for cycle-2a Bash hook.
- `reason`: human-readable; <120 chars.
- `content-hash`: FNV-1a-64 hex (16 chars), or empty for hook-internal-error.

### 5.3 Morning briefing

Existing review step (cycle-1a + cycle-1b) extends to group by `kind`:

```
Security: policy refusals (since last briefing)
  - bash:secrets-read (3) — see policy-refusals.log
  - outbound:layer-2 (1) — process.env.GITHUB_PAT in github-write content
  - bash:hook-internal-error (1) — TypeError in claude-code-hook.js  ← TRIAGE
```

`hook-internal-error` entries get a triage flag — they indicate a hook bug rather than a defended attack.

---

## 6. AGENTS.md and `system/rules/security.md`

### 6.1 AGENTS.md change

Cycle-1b adds a "Outbound writes" Hard Rule. Cycle-2a adds one more line:

```markdown
- **Bash policy.** Bash commands are gated by `system/scripts/hooks/claude-code.js --on-pre-bash` against patterns in `system/scripts/lib/bash-sensitive-patterns.js`. Sensitive commands block at the hook layer; refusals land in `policy-refusals.log`. Defense-in-depth, not a sandbox — see `system/rules/security.md` for limitations.
```

Single line added to the Hard Rules list. Total cycle-2a token addition to AGENTS.md: ~1 line.

### 6.2 `system/rules/security.md` updates

Cycle-1b creates this file. Cycle-2a appends:
- Bash sensitive-patterns reference (link to `bash-sensitive-patterns.js` for the canonical list; rationale + examples per rule).
- Known limitations subsection (encoded payloads, aliased binaries, compound-command edge cases).
- `policy-refusals.log` schema reference.
- Worked example: legit-but-blocked command and the workaround pattern (Kevin edits `bash-sensitive-patterns.js` PR-style; or rewrites the command without the matched substring).

Estimated addition: ~80 lines.

---

## 7. Migration

1. **Order**: deploy after cycle-1b (refusal log infrastructure must exist).
2. **Preflight**: `git status` clean; on a non-feature branch (other agent's branch should be merged or work staged elsewhere).
3. **Refactor pass** (single PR or commit chain):
   - Rewrite `secrets.js` (remove `loadSecrets`, change `requireSecret(key)` → `requireSecret(workspaceDir, key)`).
   - Update `oauth.js` to pass `workspaceDir` through.
   - Refactor 5 direct `process.env.<SECRET>` readers in `auth-discord.js`, `discord-bot.js`.
   - Add `system/scripts/lib/safe-env.js`.
   - Update 3 `spawn`/`fork` sites to use `safeEnv()`.
   - **Grep audit** (mandatory before merge): `grep -rE "process\.env\.[A-Z_]+(TOKEN|KEY|SECRET|PAT|PASS|REFRESH)" system/ user-data/scripts/` returns zero matches outside `secrets.js`.
4. **Hook pass**:
   - Add `system/scripts/lib/bash-sensitive-patterns.js`.
   - Add `--on-pre-bash` mode to `claude-code-hook.js`.
   - Add Bash matcher to `.claude/settings.json`.
5. **Refusal log rename** (if cycle-1b shipped first):
   - Rename file: `mv user-data/state/outbound-refusals.log user-data/state/policy-refusals.log` (only if non-empty; otherwise let cycle-2a create fresh).
   - Rename module: `outbound-log.js` → `policy-refusals-log.js`. Update `outbound-policy.js` import + function name.
   - Update morning-briefing protocol reference.
6. **Restart discord-bot** so it picks up new hook config and re-spawns subprocesses with `safeEnv()`.
7. **Smoke**: synthetic Bash command `cat user-data/secrets/.env` blocked; subprocess `process.env` has no `DISCORD_BOT_TOKEN`.

No data migration on `secrets/.env` (mode 0600 already enforced by cycle-3 hotfix).

---

## 8. Risk register

| Risk | Mitigation |
|---|---|
| Refactor misses a `process.env.<SECRET>` reader | Mandatory grep audit in DoD #2; runs against `system/` and `user-data/scripts/`. |
| `safeEnv()` excludes a var some subprocess actually needs | Allowlist conservative growth; smoke test discord-bot end-to-end; add to allowlist with rationale if needed. |
| `requireSecret` per-call I/O latency in a hot path | ~1ms per call on SSD; secrets accessed 2-3x per session. Acceptable. Future opt-in cache with TTL if hot path emerges. |
| Bash hook adds 50-100ms per command | Lazy import of patterns module; first-match-wins; <50ms target enforced via test. If unacceptable in practice, consider a long-lived hook daemon (out of scope; future cycle). |
| Pattern false positive blocks legitimate command | Refusal log surfaced in morning briefing; Kevin tunes patterns. No bypass mode (per autonomy preference); workaround = edit patterns or rewrite command. |
| Pattern false negative — base64/alias/compound bypasses | Documented as known limitation; lazy-read fix is the structural defense. Hook is defense-in-depth, not a sandbox. |
| Hook itself has a bug → silent passthrough loses defense | Fail-closed pattern: any uncaught error in hook exits 2 with `hook-internal-error` reason. Morning briefing flags these for triage. |
| Concurrent Bash invocations race on log file | `appendFileSync` is atomic at OS level for small writes. No race. |
| discord.js library caches BOT_TOKEN in heap | Acknowledged residual. Heap not Bash-readable; out of scope for cycle-2a. |
| `loadSecrets` removal breaks an unknown caller | Removal pass with `grep -rn "loadSecrets" system/ user-data/scripts/`; replace any survivors. Tests would have caught a missing import. |
| Other agent's `feat/a3-session-end-sweep` work has touched these files | Re-read `claude-code-hook.js`, `.claude/settings.json`, `secrets.js`, `discord-bot.js` before edits. Coordinate via git merge after their branch lands. |

---

## 9. Time budget

- **Target:** 1 working day.
- **Ceiling:** 2 working days.
- **Per-component**:
  - `secrets.js` rewrite: 1h
  - `safe-env.js` helper: 0.25h
  - Refactor 5 readers + 3 spawn sites: 1h
  - Grep audit + cleanup: 0.25h
  - `bash-sensitive-patterns.js` + unit tests (positive + negative cases per rule): 2h
  - `claude-code-hook.js --on-pre-bash` mode + tests: 1h
  - `.claude/settings.json` Bash matcher: 0.25h
  - Refusal log rename (if needed): 0.5h
  - AGENTS.md + `system/rules/security.md`: 0.75h
  - Acceptance tests (S6, S8): 1.5h
  - Smoke + cleanup: 0.5h

---

## 10. Tests

### 10.1 Unit tests (deterministic, `node --test`)

`system/tests/security/`:
- `secrets-lazy-read.test.js` — `requireSecret` reads from file; `process.env` is not polluted (assertion: `assert.equal(process.env.TEST_KEY, undefined)` after `requireSecret`); missing key throws with the canonical message.
- `safe-env.test.js` — `safeEnv()` returns only allowlisted keys; `safeEnv({EXTRA: '1'})` includes EXTRA without expanding the default allowlist; spawned subprocess inherits only those.
- `bash-patterns.test.js` — for each rule: positive cases trip; negative cases (close paraphrase + benign) don't. Edge cases: paths with spaces (quoted), command pipelines, escaped chars, leading whitespace, embedded comments.
- `claude-code-hook-bash.test.js` — `--on-pre-bash` mode reads stdin JSON; exits 0 for benign, exits 2 for sensitive, exits 2 with `hook-internal-error` for malformed input.
- `policy-refusals-log.test.js` — append; rotation at 1MB; new schema columns (kind); FNV-1a hash format.

### 10.2 Acceptance tests (mechanical)

- `s6-supply-chain-postinstall.test.js` — synthetic postinstall script that attempts `cat user-data/secrets/.env` via Bash; the hook blocks at `secrets-read`. Pre-install file unchanged.
- `s8-jailbreak-cat-env.test.js` — synthetic `env | grep TOKEN` Bash command; hook blocks at `env-dump`.
- `s8-jailbreak-cat-secrets.test.js` — synthetic `cat user-data/secrets/.env` Bash command; hook blocks at `secrets-read`.

### 10.3 Smoke (manual, post-deploy)

1. Drop synthetic Bash `cat user-data/secrets/.env`; confirm hook blocks; refusal log entry; agent's next reply mentions block.
2. Spawn discord-bot subprocess; confirm `process.env` inside subprocess does NOT contain `DISCORD_BOT_TOKEN`, `GITHUB_PAT`, OAuth refresh tokens; confirm bot still functions end-to-end (Kevin sends a DM, bot replies).
3. Run `requireSecret(workspaceDir, 'DISCORD_BOT_TOKEN')` in REPL; confirm value returned, `process.env.DISCORD_BOT_TOKEN` still undefined.
4. Run `bash-sensitive-patterns.js` directly with mock commands; confirm first-match-wins.

---

## 11. Definition of done

1. `requireSecret(workspaceDir, key)` reads `secrets/.env` per call; `process.env` not polluted. `loadSecrets()` removed. Unit tests pass.
2. **Grep audit** confirms zero `process.env.<SECRET-shaped>` readers outside `secrets.js`.
3. `safeEnv()` helper exists; every `spawn`/`fork`/`exec` call site uses it. Unit test verifies subprocess env contents.
4. `bash-sensitive-patterns.js` covers 6 rules with positive + negative unit tests for each.
5. `claude-code-hook.js --on-pre-bash` mode wired in `.claude/settings.json`; fail-closed try/catch; <50ms typical runtime.
6. `policy-refusals.log` covers `kind=bash` entries; rotation works; renamed cleanly from cycle-1b's `outbound-refusals.log` if applicable.
7. AGENTS.md gains 1-line Bash policy rule. `system/rules/security.md` extended with bash patterns + limitations.
8. Morning-briefing protocol surfaces refusals grouped by `kind`; flags `hook-internal-error` separately for triage.
9. S6 and S8 acceptance tests pass.
10. Smoke tests 1-4 pass manually.
11. Existing test suite green. Discord-bot functions end-to-end after restart.
12. AGENTS.md net token count not increased (1 line up; cycle-1b's detail-thinning move offset).
13. Zero new files Kevin maintains. Zero confirm prompts.

---

## 12. Hand-off to cycle-2b

When cycle-2a signs off:
- Cycle-2b's spec frontmatter cites this spec's path + commit SHA + cycle-1a + cycle-1b.
- Cycle-2b's brainstorm starts with G-28 (hook tampering via fork's `.claude/settings.json`) and G-37 (compromised MCP server). Tamper detection group.
- Cycle-2a's `policy-refusals.log` and `system/rules/security.md` are reusable — cycle-2b's tamper-detection findings would surface in the same refusal log.
- Cycle-2c (rule backstops) starts after 2b: G-01, G-02, G-03, G-05, G-13, G-27.

---

## 13. Coupling note (other-agent collision)

At spec-write time, the other agent's `feat/a3-session-end-sweep` branch is active. Coupling concerns for cycle-2a:

- **`claude-code-hook.js`**: other agent landed `feat(stop-hook): write session-handoff + hot.md auto-line on every Stop` — adds Stop-mode logic. Cycle-2a adds `--on-pre-bash` mode. Different lifecycle modes; low conflict, but re-read the file before edits to confirm structure.
- **`.claude/settings.json`**: other agent may have edited the hooks block. Cycle-2a adds a Bash matcher. Re-read to confirm the JSON shape and merge cleanly.
- **`secrets.js`**: not in the other agent's commit log, but verify before edit.
- **AGENTS.md "Hard Rules"**: other agent edited "Session End" section and added rules. Cycle-2a appends one Bash policy rule to the Hard Rules list. Different sections; low conflict.

Implementation paused until user greenlights. Re-read this section + cycle-1a/1b coupling notes when resuming.

---
