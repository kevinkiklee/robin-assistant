# Robin v2 Phase 4a — Daily-Use Safety Floor

**Status:** Design (pre-implementation)
**Date:** 2026-05-10
**Phase:** 4a (first sub-phase of Phase 4 from `2026-05-09-robin-v2-foundation-design.md`)
**Predecessors:** Phase 3a (embedder profiles, `v6.0.0-alpha.8a`), Phase 3b (v1→v2 migrator + missing integrations, `v6.0.0-alpha.8b`).

---

## 1. Phase 4 envelope (context for 4a)

The user asked: "look over v1 and migrate over remaining features." That's the whole of Phase 4 — daily-use parity + self-improvement — too large for one spec. Decomposition agreed during brainstorming:

| Sub-phase | Scope |
|---|---|
| **4a — Daily-use safety floor (this spec)** | Bash policy, PII guard inside MCP handlers, tamper detection, auto-recall on prompt, multi-session registry + file locks, pre-commit privacy hook. |
| 4b — Action policy + behavior shaping | AUTO/ASK/NEVER + action-trust ledger, comm-style profile, predictions+calibration. |
| 4c — Knowledge ops | Ingest, Lint, Audit, Save conversation, Deep-ripple. |
| 4d — Cross-platform job runner | launchd/cron/Task Scheduler with markdown job definitions, reconciler heartbeat, optional v1 jobs (daily briefing, weekly review, etc.). |
| 4e — Learning loop | Trained reranker over `recall_events`, knowledge-promotion classifier. |

**Drop / not migrating:** publish flow (askrobin.io is CLI-in-VM now), watches (already dropped per foundation spec), markdown read-shim (DB is source of truth), quarterly self-assessment (folded into 4b calibration).

4a is sequenced first because without it v2 is *less safe* than v1 and the agent loses v1's "memory shows up before you finish your sentence" UX. Hard prerequisite for cutover.

## 2. Goal

Restore the v1 safety + auto-recall guarantees on top of v2's MCP-first architecture, in a form that survives the npm-global install model (no per-project `.claude/settings.json`).

## 3. Architectural shift from v1

| Concern | v1 placement | v2 placement | Why moved |
|---|---|---|---|
| PII pre-write | Claude Code `PreToolUse Write` hook against `user-data/memory/...` | Inside MCP handlers (`recordEvent`, `remember`, `record_correction`, `update_rule`) | v2 memory writes go through MCP, not file paths. |
| Bash policy | Project `PreToolUse Bash` hook | User-level `PreToolUse Bash` hook | npm-global install means no project workspace; user settings are the only stable home. |
| Auto-recall | Project `UserPromptSubmit` hook scanning entity aliases + activity-keyword map | User-level `UserPromptSubmit` hook calling the existing `recall` MCP tool as a thin shim | Reuses the MCP-side recall pipeline; drops the keyword index (subsumed by entity aliases). |
| Tamper detection | `SessionStart` runs full check | Daemon-boot runs full check; SessionStart reads cached result | Tamper-check is expensive; SessionStart fires often; daemon boot is the long-lived process. |
| Multi-session coordination | Markdown session log | `runtime:sessions` table + `<robinHome>/locks/` cooperative file locks | DB-shaped state; consistent with v2's "DB is source of truth." |
| Pre-commit privacy | `npm install` postinstall | Standalone `robin pre-commit install` command, run from inside the user's repo | `robin install` may run from `npm install -g` with no project cwd — separating the concern. |

## 4. File layout

```
src/
  hooks/
    handlers/
      bash-policy.js         # PreToolUse Bash — static pattern match
      auto-recall.js         # UserPromptSubmit — calls recall MCP
      session-start.js       # SessionStart — register + tamper warnings
      stop-hook.js           # (already exists — biographer-pending)
    bash-patterns.js         # 7 deny rules (lifted + refreshed)
    pii-patterns.js          # shared with src/outbound/patterns.js
    cli.js                   # `robin hook <phase>` dispatcher
    disabled.js              # reads <robinHome>/hooks-disabled.txt
  install/
    hooks-settings.js        # ~/.claude/settings.json + Gemini equivalent
    hook-shim.js             # writes bin/robin-hook.sh (with-node.sh-equivalent)
    pre-commit.js            # git pre-commit installer (lifts v1)
    agents-md.js             # (already exists)
  daemon/
    tamper-check.js          # manifest baseline + drift detection on boot
    sessions.js              # session registry helpers
    server.js                # +new endpoints: /internal/auto-recall,
                             #   /internal/session/{register,end},
                             #   /internal/recall (existing)
  cli/commands/
    doctor.js                # rebaseline, sessions purge stale, hooks lint
    hooks-disable.js         # writes hooks-disabled.txt
    hooks-enable.js
    pre-commit-install.js
    pre-commit-uninstall.js
    refusals-list.js         # `robin refusals list` for inbound PII review
    sessions-purge.js
  schema/migrations/
    0010-sessions-and-tamper.surql
```

`bin/robin` gets one new top-level subcommand: `robin hook <phase>` — invoked by Claude Code/Gemini settings via the `bin/robin-hook.sh` shim.

## 5. Components

### 5.A Bash policy

PreToolUse Bash hook. Lifts v1's `system/scripts/lib/bash-sensitive-patterns.js` to `src/hooks/bash-patterns.js` with refresh:

- **Drop:** `misrouted-write` — no canonical `user-data/artifacts/` or `upload/` paths in v2; the DB is the writable surface.
- **Keep:** `secrets-read`, `env-dump`, `destructive-rm`, `low-level-fs`, `git-expose-userdata`, `eval-injection`.
- **Add:** `db-direct-access` — refuse `surreal sql/connect/import/export` against `<robinHome>/db/`. Only the daemon may touch the DB.

Hook reads JSON from stdin per the Claude Code PreToolUse contract (current shape extracts the bash command from `tool_input.command`; field-name drift across Claude Code versions handled by a single shape-tolerant accessor). Checks `<robinHome>/hooks-disabled.txt` first for kill-switch, then matches each pattern. On match: exit 2 with stderr line `Robin: blocked Bash — <rule_name>: <why>`. Static match — no daemon round-trip.

### 5.B PII guard inside MCP handlers

Reuses `src/outbound/patterns.js` (already exists for outbound policy) but with a narrower **inbound** subset:

- **Inbound list (new, narrower):** credential shapes (API keys, OAuth tokens, password-shaped strings), obvious secrets (private key headers, JWT, AWS-style access-key shapes).
- **Outbound list (unchanged):** above + PII shapes (SSN, financial-account numbers) + verbatim-untrusted-quote (last 7d).

Rationale: medical/financial history can legitimately *enter* memory but should not *leave* via outbound writers.

Wraps four MCP handlers: `recordEvent`, `remember`, `record_correction`, `update_rule`. On match: refuse with structured error; insert into existing `outbound_refusals` table with new column `direction in ['inbound','outbound']` (added in migration 0010). User reviews refusals via `robin refusals list`. Override via CLI only: `robin remember --force "<text>"` — agents cannot bypass; agents must escalate to user.

### 5.C Tamper detection

Manifest baseline at `<robinHome>/manifest.json`, written by `robin install`:

- `package.version` of installed `robin-assistant`.
- SHA-256 of `bin/robin`, `bin/robin-hook.sh`, and key handler files (`src/hooks/handlers/*.js`, `src/daemon/server.js`).
- Stat: mode of `<robinHome>/secrets/.env` (must be 0600) and `<robinHome>/db/` (must be 0700).
- Path + checksum of supervisor file (launchd plist on macOS, systemd unit on Linux).

**Cadence:**
- **Daemon boot** runs full check (hash files, stat perms). Result → `runtime:tamper_state` row.
- **SessionStart hook** reads `runtime:tamper_state`; emits warnings to stderr; never recomputes.
- **Re-baseline triggers:** `robin install`, `robin embedder switch`, `robin doctor --rebaseline`.

Drift surfaces three ways: `kind=tamper` event recorded (audit trail), one-line warning to stderr at boot, visible via `robin doctor`.

**Scope is local-only.** Hashes catch local mutation, not supply-chain compromise. npm doesn't sign packages by default; supply-chain hardening is out of scope for 4a.

### 5.D Auto-recall on prompt

UserPromptSubmit hook. Reads JSON from stdin (current user message + transcript path from Claude Code's hook payload).

**Prior-turn access:** Claude Code's UserPromptSubmit payload includes both the current prompt and the `transcript_path`. The hook reads the tail of that transcript file (capped at 8 KB) to extract the previous assistant message. We *also* persist `transcript_path` on the `runtime:sessions` row at SessionStart so daemon-side components (biographer process-pending, future tools) can locate the transcript without depending on a hook payload — but the auto-recall hook itself uses the path from its own stdin payload, no DB round-trip on the read.

Calls `POST /internal/auto-recall` with `{query, prior_assistant, k:6, recency_days:30, token_budget:1500}`. Daemon endpoint runs the same recall path the MCP `recall` tool uses, formats hits as:

```html
<!-- relevant memory -->
[entity:Karen] partner; gardener; primary contact for fertilizer/...
[event 2026-04-12] discussed sourdough hydration ratio (62%)
[episode 2026-05-01] wrapped lunch-money sync gap; trust=high
<!-- /relevant memory -->
```

Hook is **fail-soft**: any error/timeout (300ms hard cap) → exit 0, no injection. Token cap configurable in `<robinHome>/config.json`.

**Telemetry:** new `runtime:auto_recall_telemetry` row per fire — count, query length, hits returned, tokens injected, latency_ms. Tuning of k/recency_days/token_budget happens in 4b once we have real data.

### 5.E Multi-session registry + file locks

Migration 0010 adds `runtime:sessions` (`{session_id, host, started_at, last_seen_at, pid, transcript_path, status}`).

- **SessionStart hook** registers a session and prints "Robin: session 1 of N" if N > 1.
- **Stop hook** marks ended.
- **Heartbeat (60s)** marks `last_seen_at > 5min` as `status='stale'`.
- **`robin sessions purge --stale`** for hard cleanup of crashed sessions.

**File locks** under `<robinHome>/locks/` — advisory `flock(2)` on a `<command-name>.lock` file (e.g. `migrate.lock`), with the holder's PID written as the file's content. The lock is acquired with `LOCK_EX | LOCK_NB`; failure path reads the PID and prints `Robin: <command> already running (pid=<N>); aborting`, exits non-zero. Lock is released on process exit (kernel-managed, so even SIGKILL releases). Covers CLI commands that act outside the daemon's serialization: `robin migrate`, `robin install`, `robin embedder switch`, `robin migrate-from-v1`. `--force` flag overrides (rare; documented as risky).

### 5.F Pre-commit privacy hook

Standalone command (NOT bundled into `robin install`):

```
robin pre-commit install      # in user's project repo cwd
robin pre-commit uninstall
```

Lifts v1's `system/scripts/cli/install-hooks.js`. Detects whether cwd is a git repo (`git rev-parse --show-toplevel`), writes `.git/hooks/pre-commit` if missing, idempotent if already pointing at robin. Never overwrites unrelated user hooks. Documented in README under "When working in a personal repo Robin should keep clean."

Hook content scans staged diff for `.env`/`secrets/` paths and credential patterns; refuses commit on match. `robin pre-commit uninstall` removes the hook only if it points at robin.

## 6. Data flow

```
Claude Code session start
  └─ SessionStart hook
       ├─ POST /internal/session/register {host, pid, transcript_path}
       │     └─ INSERT runtime:sessions
       └─ daemon's last tamper-check result returned (cached)

User types message
  └─ UserPromptSubmit hook
       ├─ reads up to last N turns from transcript_path (cap 8 KB tail)
       └─ POST /internal/auto-recall {query, prior_assistant, k:6,
                                       recency_days:30, token_budget:1500}
            ├─ on success: stdout = <!-- relevant memory --> block
            └─ on failure (timeout/down): exit 0, no injection

Agent decides to use Bash
  └─ PreToolUse Bash hook
       ├─ checks <robinHome>/hooks-disabled.txt for kill-switch
       └─ static pattern match (no daemon roundtrip)
            └─ on match: exit 2 + stderr explanation

Agent calls recordEvent / remember / record_correction (MCP)
  └─ daemon handler
       └─ PII guard
            ├─ on match: refuse + INSERT outbound_refusals (direction='inbound')
            └─ on pass: INSERT events / etc.

Session ends OR transcript file goes stale
  └─ Stop hook → existing biographer-pending route
                 + UPDATE runtime:sessions status='ended'
  └─ heartbeat (60s): if last_seen_at > 5m ago → status='stale'
```

**Internal endpoint binding:** all `/internal/*` endpoints bind 127.0.0.1 only (already true for the daemon). No auth token in 4a (same trust boundary as the SQLite/RocksDB file).

## 7. Install / uninstall

`robin install` extends today's flow:

1. Migrate (existing).
2. MCP install (existing).
3. **Hook PATH probe** — runs `command -v robin` under `/bin/sh -lc`. If empty (nvm/asdf case), the install writes `<robin-package-root>/bin/robin-hook.sh` (alongside the existing `bin/robin`, shipped in the npm tarball) — a shell shim that resolves node from `$ROBIN_NODE` / `PATH` / common paths / nvm / asdf and execs the JS dispatcher (lifts v1's `with-node.sh`). Hooks invoke that absolute path, not `robin` directly. The package root is resolved via `import.meta.url` walk-up (same approach used by `src/runtime/home.js`). **Fail loud** if neither `robin` nor a usable node can be found from the install-time shell.
4. **Hooks install** — reads `~/.claude/settings.json`, deep-merges robin entries into `hooks.{PreToolUse, UserPromptSubmit, SessionStart, Stop}`. Each robin-owned entry has a stable `command` string starting with the absolute path to our shim — that's our identity for uninstall. Manifest of owned entries → `<robinHome>/installed-hooks.json` for fast diff on `robin uninstall` / `robin install --hooks-only`. Same write to Gemini CLI settings (with reduced surface — see §10).
5. **Tamper baseline write** — manifest at `<robinHome>/manifest.json`.

**Pre-commit is NOT part of `robin install`** — it's `robin pre-commit install` run separately from inside a project repo.

**Flags added to `robin install`:** `--no-hooks`, `--hooks-only`. **`robin uninstall`** removes hooks by matching the stable command-string identity; falls back to the manifest. Pre-commit hooks remain user-managed (uninstall doesn't touch them).

## 8. Cutover-period coordination (v1 + v2 both installed)

During the v1→v2 transition Kevin will have v1's project-level `.claude/settings.json` *and* v2's user-level `~/.claude/settings.json` active simultaneously. Claude Code merges both, so both fire.

- **UserPromptSubmit:** v2 hook checks for v1 marker (existence of `<workspace>/system/scripts/hooks/host-hook.js` reachable via `CLAUDE_PROJECT_DIR`). When detected, v2 **suppresses** the auto-recall injection and logs once-per-session to stderr: `"Robin: v1 hooks active in this project; v2 auto-recall yielding."` Avoids double `<!-- relevant memory -->` blocks from two different DBs.
- **Bash policy:** idempotent — both deny on the same patterns, no suppression needed.
- **SessionStart registry:** v2 still registers; only the auto-recall path yields.
- **Cleanup:** documented runbook step after `robin migrate-from-v1` completes — `cd <v1-repo> && rm .claude/settings.json` (or selectively delete the robin-owned hooks block).

## 9. Tests

**Unit:**
- `bash-patterns.test.js` — table-driven, each rule × positive + negative cases.
- `pii-patterns-inbound.test.js` — credential, secret, JWT, AWS-key shapes; assert refused write + `outbound_refusals` row.
- `tamper-check.test.js` — fresh baseline, mutated baseline, perm drift on `secrets/.env`, supervisor checksum mismatch.
- `auto-recall.test.js` — happy path (formatted block), daemon-down fail-soft, token-budget truncation via tokenizer.
- `auto-recall-budget.test.js` — uses tokenizer dep to assert injected block ≤ token_budget.
- `sessions.test.js` — register, heartbeat-stale promotion, end, "session N of K" format.
- `hooks-cli.test.js` — `robin hook <phase>` dispatches correctly.
- `hooks-disabled.test.js` — kill-switch file blocks fire without daemon round-trip.

**Integration:**
- `hooks-install-roundtrip.test.js` — snapshot test. Synthetic user `~/.claude/settings.json` with foreign hooks → install → uninstall → assert exact pre-state recovery. Catches schema drift and accidental clobbering.
- `auto-recall.integration.test.js` — full daemon → recall → injection format end-to-end via `tests/integration/_helpers/daemon-fixture.js` (mem://).
- `cutover-collision.test.js` — install v2 hooks, plant v1 marker, fire UserPromptSubmit, assert auto-recall yields and stderr line emitted.

**Manual smoke (in CHANGELOG / runbook):** install → start a Claude Code session → see SessionStart line → type a message that should surface known memory → verify `<!-- relevant memory -->` block appears.

## 10. Gemini CLI parity

Gemini's hook contract is thinner than Claude Code's. **Decision for 4a:**

- Ship Gemini for **Bash policy + Stop + SessionStart**.
- Auto-recall on Gemini documented as a 4a follow-up after we benchmark how much value it adds vs Gemini's native context-management.

The hook install code is already host-aware (`src/install/agents-md.js` writes both `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md`); same dispatch pattern extends to settings.

## 11. Failure modes + escape hatches

| Failure | Behavior | Escape |
|---|---|---|
| Daemon down on UserPromptSubmit | 300ms hard timeout → exit 0, no injection. Recovery automatic next turn. | None needed. |
| Bash policy false-positive | Tool call refused (exit 2). | `<robinHome>/hooks-disabled.txt` lists hooks to skip; `robin hooks disable bash-policy` writes it; `robin hooks enable` removes. No env-var path (subprocess inheritance unreliable). |
| PII guard false-positive on memory write | recordEvent refused; row in `outbound_refusals(direction='inbound')`. | CLI override only: `robin remember --force "<text>"`. Agents cannot bypass; must escalate to user. `robin refusals list` shows recent. |
| Tamper false-positive (legit upgrade) | Boot warning printed; daemon still starts. | `robin install` and `robin embedder switch` rewrite baseline. Manual: `robin doctor --rebaseline`. |
| Hook shim can't find node at fire-time | Hook silently exits 0 with stderr trace; host continues. | Install-time PATH probe is best-effort. `robin doctor` checks. |
| v1 + v2 both have hooks during cutover | v2 UserPromptSubmit yields with one stderr line; Bash policy idempotent. | Documented cutover step removes v1 project-level settings. |
| Multiple sessions race on `robin migrate` etc. | Lock under `<robinHome>/locks/`; second prints holder PID and exits non-zero. | Wait or `--force` (rare). |
| Crashed Claude Code (no Stop fired) | Heartbeat marks session `stale` after 5m. | `robin sessions purge --stale` for hard cleanup. |

## 12. Schema (migration 0010)

```sql
-- runtime:sessions
DEFINE TABLE runtime_sessions SCHEMAFULL;
DEFINE FIELD session_id ON runtime_sessions TYPE string;
DEFINE FIELD host ON runtime_sessions TYPE string ASSERT $value IN ['claude-code','gemini-cli'];
DEFINE FIELD pid ON runtime_sessions TYPE int;
DEFINE FIELD transcript_path ON runtime_sessions TYPE option<string>;
DEFINE FIELD started_at ON runtime_sessions TYPE datetime DEFAULT time::now();
DEFINE FIELD last_seen_at ON runtime_sessions TYPE datetime DEFAULT time::now();
DEFINE FIELD status ON runtime_sessions TYPE string ASSERT $value IN ['active','ended','stale'] DEFAULT 'active';
DEFINE INDEX idx_sessions_status ON runtime_sessions FIELDS status;

-- runtime:tamper_state (single row, key='current')
DEFINE TABLE runtime_tamper_state SCHEMAFULL;
DEFINE FIELD checked_at ON runtime_tamper_state TYPE datetime;
DEFINE FIELD ok ON runtime_tamper_state TYPE bool;
DEFINE FIELD findings ON runtime_tamper_state TYPE array<object> DEFAULT [];
-- finding shape: { kind: 'hash_drift'|'mode_drift'|'missing_file', path, expected, actual }

-- runtime:auto_recall_telemetry (append-only, 30-day TTL via prune)
DEFINE TABLE runtime_auto_recall_telemetry SCHEMAFULL;
DEFINE FIELD ts ON runtime_auto_recall_telemetry TYPE datetime DEFAULT time::now();
DEFINE FIELD query_chars ON runtime_auto_recall_telemetry TYPE int;
DEFINE FIELD hits ON runtime_auto_recall_telemetry TYPE int;
DEFINE FIELD tokens_injected ON runtime_auto_recall_telemetry TYPE int;
DEFINE FIELD latency_ms ON runtime_auto_recall_telemetry TYPE int;
DEFINE FIELD truncated ON runtime_auto_recall_telemetry TYPE bool;

-- outbound_refusals: add direction column
DEFINE FIELD direction ON outbound_refusals TYPE string ASSERT $value IN ['inbound','outbound'] DEFAULT 'outbound';
DEFINE INDEX idx_refusals_direction ON outbound_refusals FIELDS direction;
```

## 13. Open questions / explicit deferrals

1. **Auto-recall token-budget tuning.** 1500 is a guess. Telemetry table lands in 4a; tuning happens in 4b once we have real data.
2. **Tamper scope is local-only.** Supply-chain hardening (npm package signing) out of scope.
3. **Inbound vs outbound PII pattern split.** Inbound is narrower (credentials/secrets only). Refined in 4b alongside calibration.
4. **Gemini auto-recall** deferred to a 4a follow-up after benchmark.
5. **`robin doctor` minimal in 4a** — rebaseline, sessions purge stale, hooks lint settings.json. Full doctor lands in 4b.

## 14. Cutover

4a does not change the v1→v2 cutover gate (still Phase 4 daily-use parity, per foundation spec §3). It's a *prerequisite* for cutover, not the trigger. Cutover unlocks once 4a + 4b + chosen 4c/4d pieces ship and the user is comfortable.
