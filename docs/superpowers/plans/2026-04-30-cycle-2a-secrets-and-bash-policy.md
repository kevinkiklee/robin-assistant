# Cycle-2a Implementation Plan

**Spec:** `docs/superpowers/specs/2026-04-30-cycle-2a-secrets-and-bash-policy-design.md`
**Depends on:** cycle-1b (refusal-log infrastructure).

## Step 1 — Rewrite `system/scripts/sync/lib/secrets.js`

- Drop `loadSecrets()` (delete the export).
- Change `requireSecret(key)` → `requireSecret(workspaceDir, key)` — reads `secrets/.env` directly per call. Parses .env line-by-line. Throws if missing.
- Keep `saveSecret` (cycle-3 hotfix's chmod 0600 stays).

Update `system/scripts/sync/lib/oauth.js` to thread `workspaceDir` through to `requireSecret` calls.

Test: `system/tests/security/secrets-lazy-read.test.js`.

## Step 2 — `system/scripts/lib/safe-env.js`

```js
const SAFE_ENV_KEYS = ['HOME','PATH','USER','LANG','TERM','TMPDIR','NODE_PATH',
                       'ROBIN_WORKSPACE','ROBIN_AGENT_COMMAND','ROBIN_BIN','ROBIN_NO_NOTIFY'];
export function safeEnv(extras = {}) {
  const out = {};
  for (const k of SAFE_ENV_KEYS) if (k in process.env) out[k] = process.env[k];
  return { ...out, ...extras };
}
```

Test: `system/tests/security/safe-env.test.js`.

## Step 3 — Refactor direct `process.env.<SECRET>` readers

In `system/skeleton/scripts/`:
- `auth-discord.js:26` → `requireSecret(workspaceDir, 'DISCORD_BOT_TOKEN')`
- `auth-discord.js:61` → `requireSecret(workspaceDir, 'DISCORD_APP_ID')`
- `discord-bot.js:285` → `requireSecret(workspaceDir, 'DISCORD_BOT_TOKEN')`
- `discord-bot.js:44` → `requireSecret(workspaceDir, 'DISCORD_ALLOWED_USER_IDS')`
- `discord-bot.js:45` → `requireSecret(workspaceDir, 'DISCORD_ALLOWED_GUILD_ID')`

Skip non-secret reads (CLAUDE_PATH, TIMEOUT_MS, ROBIN_WORKSPACE, SPOTIFY_AUTH_PORT).

Grep audit:
```sh
grep -rE "process\.env\.[A-Z_]+(TOKEN|KEY|SECRET|PAT|PASS|REFRESH)" system/ user-data/runtime/scripts/
```
Should return zero matches outside `secrets.js`.

## Step 4 — Add `safeEnv()` to spawn sites

In each `spawn()`/`fork()`/`exec()` in:
- `system/skeleton/scripts/discord-bot.js` (claude -p subprocess)
- `system/scripts/hooks/claude-code.js` (migrate-auto-memory subprocess)
- `system/scripts/jobs/runner.js` (job execution)
- (audit `grep -rn "spawn(" system/` and add wherever missing)

Pattern: `spawn(cmd, args, { cwd, env: safeEnv(), stdio: [...] })`.

## Step 5 — `system/scripts/lib/bash-sensitive-patterns.js`

Six rules per spec §4.3:
- `secrets-read`, `env-dump`, `destructive-rm`, `low-level-fs`, `git-expose-userdata`, `eval-injection`.

Export `checkBashCommand(cmd)` returning `{blocked, name, why}` or `{blocked: false}`. First-match-wins.

Test: `system/tests/security/bash-patterns.test.js` — positive + negative per rule.

## Step 6 — Extend `system/scripts/hooks/claude-code.js`

Add `--on-pre-bash` mode:
1. Read JSON event from stdin.
2. Lazy-import `bash-sensitive-patterns.js`.
3. Lazy-import `policy-refusals-log.js`.
4. On match: append refusal (kind=bash), stderr `POLICY_REFUSED [bash:<name>]`, exit 2.
5. Top-level try/catch fail-closed: any uncaught error → exit 2 with `hook-internal-error`.

Test: `system/tests/security/claude-code-hook-bash.test.js`.

## Step 7 — Update `.claude/settings.json`

Add Bash matcher to PreToolUse:
```json
{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node system/scripts/hooks/claude-code.js --on-pre-bash" }] }
```

## Step 8 — Refusal log rename

If cycle-1b's `outbound-refusals.log` exists in user-data, migrate to `policy-refusals.log`. Update `outbound-log.js` → `policy-refusals-log.js` module name. Update import in `outbound-policy.js`. Add `kind` column to schema (cycle-1b's entries get `kind=outbound` retroactively if needed; new entries always tagged).

## Step 9 — Update AGENTS.md + `system/rules/security.md`

AGENTS.md Hard Rule:
> **Bash policy.** Bash commands are gated by `system/scripts/hooks/claude-code.js --on-pre-bash` against patterns in `system/scripts/lib/bash-sensitive-patterns.js`. Sensitive commands block at the hook layer; refusals land in `policy-refusals.log`. See `system/rules/security.md`.

Append to `security-rules.md`: bash patterns reference, known limitations (encoded bypasses, alias-laundered binaries, compound-command edge cases), `policy-refusals.log` schema with `kind` column.

## Step 10 — Acceptance tests

- `s6-supply-chain-postinstall.test.js` — synthetic Bash `cat user-data/runtime/secrets/.env` → blocked.
- `s8-jailbreak-cat-env.test.js` — `env | grep TOKEN` → blocked.

## Step 11 — Run tests + commit

## DoD verification

Confirm against cycle-2a spec §11 DoD before complete.
