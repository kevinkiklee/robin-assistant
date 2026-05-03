---
title: Pre-protocol hard-assertion hook
date: 2026-05-03
status: design
scope: robin-assistant CLI (hooks layer)
---

# Pre-protocol hard-assertion hook

## Problem

The `daily-briefing` protocol invocation override has missed 4 times. Each miss: user said "morning briefing" (or paraphrase), model composed from `system/jobs/daily-briefing.md` and never read the user-data override at `user-data/runtime/jobs/daily-briefing.md`. The override is the authoritative version — the system version is a strict subset.

Two structural fixes already landed (CLAUDE.md "## Protocols" amendment + `corrections.md` added to startup load). The corrections file states the next escalation explicitly:

> If this miss happens a 5th time, the failure mode is no longer "rule isn't visible" — it's "rule is visible and being ignored." That escalates to a hard hook (pre-protocol assertion).

This spec is that escalation.

## Goals

- **Mechanically prevent** the model from invoking a protocol without reading its user-data override (when one exists).
- Cover both failure modes:
  - Pre-emptive: model never opens the override file at all (composes from system knowledge or only the system version).
  - Reactive: model opens `system/jobs/<name>.md` first or instead of the user-data override.
- Surface enforcement events to telemetry so trends inform iteration.
- Keep scope tight to protocol invocation — do not generalize to arbitrary file overrides yet.

## Non-goals

- Bypass surfaces (Bash `cat`, Glob, Grep, Edit/Write of system files, slash-command paths). Out of scope; address case-by-case if telemetry shows the model adopting them.
- Generalizing override enforcement to non-protocol files (`custom-rules.md`, integrations). Defer until a documented miss exists.
- Per-protocol severity tunables. All protocols enforce identically.
- Auto-retire stale enforcement. Dream observation only.
- Trigger phrase fuzzy matching (Levenshtein / semantic similarity). Word-boundary substring is sufficient for documented triggers.
- Cap on injection size if many triggers fire in one prompt. Theoretical edge case; address if observed.
- Per-protocol "expected fire frequency" calibration for Dream feedback. Add only when usage data justifies thresholds.

## Architecture

Two existing hook modes get new behavior:

### `onUserPromptSubmit`

Parses prompt for protocol triggers and injects override reminders.

- **Match rule:** case-insensitive, word-boundary regex (`\bphrase\b` with whitespace/punctuation as boundaries). Avoids false positives like "the daily briefing system" matching `daily briefing`.
- **Trigger source:** each protocol's `triggers:` frontmatter array. Trigger map merged across `system/jobs/` + `user-data/runtime/jobs/` (precedence below).
- **Always writes per-turn state**, even when no trigger fires. This prevents stale state from a prior turn affecting the next one.
- **Conditional injection:** for each matched protocol where a `user-data/runtime/jobs/<name>.md` override exists, injects a `<system-reminder>` block telling the model to read the override first.

### `onPreToolUse`

On every `Read` tool call (path at `event.tool_input.file_path`), two paths:

- **Read of `user-data/runtime/jobs/<name>.md`** → mark `<name>` as Read in turn state (read-modify-atomic-write), allow.
- **Read of `system/jobs/<name>.md`** → check turn state.
  - If state file mtime > 24h old → treat as no state (allow).
  - Else if `<name>` triggered this turn AND override file exists AND `<name>` not in `overrides_read` → block via `POLICY_REFUSED [protocol-override:must-read-user-data]: <why>` to stderr + `exit(2)`.
  - Else → allow.

### Trigger precedence

Three cases for `triggers:` in user-data override frontmatter:

1. **Non-empty array** → user-data wins; system triggers ignored for this protocol.
2. **Explicit empty `triggers: []`** → user-data wins; protocol opts out of trigger detection entirely (intentional silence).
3. **No `triggers:` key** → fall back to system triggers.

### Workspace resolution

Hook honors `ROBIN_WORKSPACE` env var when present (matches the `auto-memory.js` precedent from the e2e harness arc), otherwise falls back to package root. Override-existence check uses resolved workspace. State file lives under resolved workspace's `user-data/runtime/state/protocol-overrides/`.

### Hook ordering (assumed)

Assumption to verify against Claude Code documentation pre-merge: `onUserPromptSubmit` fully completes before any subsequent `onPreToolUse` for that turn; concurrent `onPreToolUse` calls within one model turn are serialized. Existing project code does sequential file writes with no locking, so this assumption already underlies other hooks. State writes use atomic rename (write tmp, rename) for crash safety regardless.

### Telemetry

Every fire (injection, block, hook error) appends one JSONL line to `state/telemetry/protocol-override-enforcement.log`. Existing telemetry files (`policy-refusals.log`, `verbose-output.log`) don't auto-rotate; this one matches the pattern. Dream Phase 4 housekeeping prunes if growth becomes a problem (defer until measured).

### Cost

- `onUserPromptSubmit`: parses ~24 small markdown frontmatters per invocation (~10ms estimate); one `existsSync` per matched protocol; one atomic state write. Once per turn.
- `onPreToolUse`: one state JSON read (~200 bytes) plus one `statSync` per Read of `system/jobs/*.md` or `user-data/runtime/jobs/*.md`. Sub-ms per Read. No frontmatter reparsing.

### Design rationale

The hook enforces a *stricter* rule (read user-data BEFORE system) than the underlying contract (user-data WINS over system on conflicts). Read-order enforcement is the simplest mechanical approximation of conflict-resolution behavior — checking which file content "won" in the model's output is impractical; checking which file was Read first is trivial. The cost is one extra ordering constraint the model probably wouldn't naturally violate anyway.

## Components (new)

- **`system/scripts/lib/protocol-trigger-match.js`** — thin matcher built on the existing `protocol-frontmatter.js` parser. Exports:
  - `loadTriggerMap(repoRoot)` returning `{name → [phrase]}` merged across `system/jobs/` + `user-data/runtime/jobs/` per the trigger precedence rules above.
  - `findMatchingProtocols(promptText, triggerMap)` — word-boundary matcher.
- **`system/scripts/hooks/lib/protocol-override-state.js`** — per-session state I/O at `user-data/runtime/state/protocol-overrides/<session_id>.json` (session_id from `event.session_id`, fallback `'unknown'`). Schema:
  ```json
  {
    "session_id": "<id>",
    "turn_started_at": "2026-05-03T...",
    "triggers_fired": ["daily-briefing"],
    "overrides_read": []
  }
  ```
  All writes atomic (tmp + rename).
- **`system/scripts/diagnostics/check-protocol-triggers.js`** — lint with one rule: error if a protocol file is missing the `triggers:` key. Empty `triggers: []` is valid (intentional opt-out). Wired into `.github/workflows/tests.yml` as a step in the `unit` job (lint failures break CI). Also exposed as `npm run check-protocol-triggers`.

## Components (modified)

- **`system/scripts/hooks/claude-code.js`** — extend `onUserPromptSubmit` (always-overwrite state; conditional inject) and `onPreToolUse` (Read enforcement). Preserves existing fail-mode contract.
- **`system/jobs/dream.md`** — Phase 3 gains "Hook enforcement review" step (details below). Pre-merge gate: re-measure with `measure-tokens` to confirm the addition fits within the per-protocol cap recently tightened in commit `dc73a6c`. Fallback if over cap: split into separate `system/jobs/hook-enforcement-review.md` agent job (scheduled weekly), and Dream just calls into it.
- **`system/jobs/weekly-review.md`** — gains "Hook enforcement summary" section (counts per protocol, this week vs last week).
- **`system/jobs/{_robin-sync,audit,backup,migrate-auto-memory,outcome-check,watch-topics}.md`** — add `triggers: []` to frontmatter (opt-out from trigger lint; these are scheduled-only, not user-invoked).
- **`CLAUDE.md`** — Operational Rules section gains a brief note documenting the hook so the model isn't surprised by a block: "Protocol invocation surfaces a hook reminder to read the user-data override first; ignoring it is mechanically blocked at PreToolUse."
- **`.github/workflows/tests.yml`** — add `npm run check-protocol-triggers` step to the `unit` job before tests run.
- **`package.json`** — add `check-protocol-triggers` script.
- **`CHANGELOG.md`**.

## Data flow (canonical miss case → enforced)

```
1. User: "give me my morning briefing"
2. onUserPromptSubmit (event.session_id = "abc123"):
   - loadTriggerMap → {"morning briefing" → daily-briefing, ...}
   - word-boundary match → [daily-briefing]
   - user-data/runtime/jobs/daily-briefing.md exists → yes
   - atomic-write state: { session_id: "abc123",
       turn_started_at: "2026-05-03T...", triggers_fired: [daily-briefing],
       overrides_read: [] }
   - inject <system-reminder>: "Override exists at
     user-data/runtime/jobs/daily-briefing.md — read it FIRST before
     any other action on this protocol."
   - log JSONL: {ts, session, daily-briefing, "injected", phrase: "morning briefing"}
3. Model attempts Read system/jobs/daily-briefing.md (the historical miss)
4. onPreToolUse (event.tool_input.file_path = ".../system/jobs/daily-briefing.md"):
   - state file mtime within 24h → use it
   - daily-briefing in triggers_fired, NOT in overrides_read
   - override file exists → BLOCK
   - stderr: POLICY_REFUSED [protocol-override:must-read-user-data]:
     daily-briefing override not yet read; read user-data/runtime/jobs/daily-briefing.md first
   - exit(2)
   - log JSONL: {ts, session, daily-briefing, "blocked"}
5. Model reads user-data/runtime/jobs/daily-briefing.md
6. onPreToolUse: read-modify-atomic-write state (overrides_read += daily-briefing) → allow
7. Model reads system/jobs/daily-briefing.md (now in overrides_read → allowed)
8. Model proceeds to render briefing using user-data override

Subsequent turn with no protocol invocation:
9. User: "what's on my calendar today"
10. onUserPromptSubmit:
    - no trigger matches
    - atomic-write state: { ..., triggers_fired: [], overrides_read: [] }
      (always-overwrite ensures stale "daily-briefing triggered" state is gone)
    - no injection
11. Model can now Read system/jobs/* freely (no enforcement applies)
```

State file lifetime: created/overwritten on every `onUserPromptSubmit`, mutated on Read of override, read on Read of system file, mtime-checked on read. Stale files (>24h, e.g., session crashed) treated as no-state. Periodic cleanup of orphaned files: Dream Phase 4 housekeeping prunes any state file whose `session_id` doesn't appear in `runtime/state/sessions.md` AND whose mtime is >24h.

## Error handling

Per-mode fail policy, matching the existing `f201dba fix(hooks): per-mode fail-open vs fail-closed for malformed stdin` pattern.

### `onUserPromptSubmit` — fail open

If frontmatter parse, trigger-map build, override-existence check, or state write fails → log telemetry as `severity=hook_error`, allow prompt through unchanged.

**State-write-failure mitigation.** If `onUserPromptSubmit` fails to write state, the hook attempts to DELETE the existing state file (best-effort, ignoring errors). `onPreToolUse` then falls into the no-state allow path, eliminating the false-block window. Both write failure AND delete failure are logged as `severity=hook_error` to telemetry. The combined-failure case (both write and delete fail — e.g., disk full + permission lost) leaves prior state stuck until the 24h mtime fallback, but is sufficiently improbable to accept.

### `onPreToolUse` — fail open

If state read or override-existence check fails → log `severity=hook_error`, allow Read. Cost of missed block is one duplicated miss; cost of breaking ALL Reads is catastrophic.

### State write atomicity

Tmp file + rename. Crash mid-write leaves prior state intact. State directory created lazily on first write.

### Telemetry write failures

Silent. Telemetry must never break enforcement.

## Edge cases

- **Protocol with `triggers: []`** (intentional opt-out) → no enforcement, no lint warning.
- **Malformed frontmatter** on a single protocol → that protocol excluded from trigger map; others unaffected; one telemetry note.
- **Stale state file** (>24h, e.g., session crashed) → treated as no state by `onPreToolUse` mtime check; rebuilt on next `onUserPromptSubmit`.
- **Multiple concurrent sessions** → one state file per session_id; no clobbering.
- **Same protocol triggered twice in one prompt** → idempotent (set semantics for `triggers_fired`).
- **User-only protocol** (exists only in `user-data/runtime/jobs/`, no system version) → trigger fires, no system file to block on, injection still serves as a reminder.
- **Quoted prior conversation in user prompts** (user pastes back chat log containing `"give me my morning briefing"`) — `onUserPromptSubmit` scans full prompt text and will false-positive. Cost: one needless override Read. Acceptable.
- **Trigger overlap** between protocols (`["briefing"]` and `["daily briefing"]`) — both fire, both injected. Acceptable (model gets two reminders, complies with both).

## Dream Phase 3 feedback

Dream's existing Phase 3 self-improvement pass gains one new step: **Hook enforcement review.**

Reads `state/telemetry/protocol-override-enforcement.log` for entries with `ts > last_dream_at`. Aggregates by protocol. Emits:

- **Reactive block fired ≥2 times for one protocol since last Dream run** → append a recurring-miss note to `corrections.md`: protocol name, fire count, timestamps, and the line "Hook is enforcing but model still attempts the wrong file — investigate whether the injection text needs to be louder or whether this signals model drift." Threshold ≥2 (not ≥1) filters single accidents while still surfacing genuine recurrence; threshold ≥3 was rejected because the hook exists *because* even one miss is signal.
- **`severity=hook_error` entries** → flag in `dream-state.md` `## Notable` section with the error string; if same error class repeats ≥3 times, append a learning-queue note to investigate the hook itself.

The "hook never fires for N days" heuristic was rejected — protocols have wildly different expected fire frequencies (`quarterly-self-assessment` fires ~4x/year), and there's no calibration data to set per-protocol thresholds in v1. If usage patterns later suggest a useful frequency baseline, add it then.

These are observation appends only — Dream never auto-edits the hook, the trigger lists, or protocol files themselves. The user reviews on next session start (corrections.md is in startup load) or weekly review.

## Testing

### E2E scenarios (under `system/tests/e2e/hooks/`, using the existing harness)

- `protocol-override-injection.test.js` — UserPromptSubmit injects when trigger fires + override exists; doesn't inject when no override.
- `protocol-override-no-false-positive.test.js` — prompt "what does the daily briefing system do?" does NOT match (word-boundary check).
- `protocol-override-block-system-read.test.js` — PreToolUse blocks system Read when trigger fired + override not yet read; refusal text matches expected `POLICY_REFUSED` shape.
- `protocol-override-allow-after-override-read.test.js` — Read of user-data first, then Read of system → both allowed.
- `protocol-override-no-trigger-no-block.test.js` — model reads system file without trigger fire → not blocked.
- `protocol-override-no-override-no-block.test.js` — trigger fires for protocol with no user-data override → not blocked.
- `protocol-override-stale-state.test.js` — state file mtime >24h old → PreToolUse treats as no state, allows.
- `protocol-override-cross-turn-clears.test.js` — turn 1 fires trigger, turn 2 does not → turn 2 Read of system file is allowed (verifies always-overwrite).
- `protocol-override-fail-open.test.js` — corrupt state file → hook logs `severity=hook_error`, allows.
- `protocol-override-state-write-failure.test.js` — state write fails → hook attempts delete; PreToolUse allows.

### Unit tests

- `system/tests/lib/protocol-trigger-match.test.js` — frontmatter parse via existing parser, word-boundary matching, all three precedence cases (user-data non-empty wins, user-data empty wins, user-data missing falls back to system).
- `system/tests/hooks/protocol-override-state.test.js` — atomic writes, stale-file mtime handling, multi-session isolation.
- `system/tests/diagnostics/check-protocol-triggers.test.js` — lint flags missing `triggers:`, treats `[]` as valid.
- `system/tests/jobs/dream-hook-enforcement-review.test.js` — Dream Phase 3 step aggregates correctly, applies ≥2 threshold, appends to `corrections.md`.

## Pre-merge verification gates

Before merging this change:

1. **Verify Claude Code's hook serialization guarantee** against current Claude Code documentation. Confirm `onUserPromptSubmit` completes before any subsequent `onPreToolUse` for that turn, and that concurrent `onPreToolUse` calls within one model turn are serialized. If either is false, design needs locking primitives (file locks on the state file).
2. **Verify Claude Code's UserPromptSubmit injection mechanism.** Inspect the hook's return contract (stdout JSON shape, env vars, or whatever Claude Code uses). Confirm the planned `<system-reminder>` injection actually reaches the model. If the mechanism differs, adjust `onUserPromptSubmit` return shape accordingly (no impact on rest of design).
3. **Re-measure `dream.md` token count** after Phase 3 + Phase 4 additions. If over per-protocol cap, split into separate `system/jobs/hook-enforcement-review.md` job.

## Scope

**M.** Touches: 1 hook file (extended), 3 new scripts, 6 protocol-file frontmatter additions, CLAUDE.md note, weekly-review section, dream Phase 3 + 4 additions, CI workflow step, package.json script, ~13 tests. No public-facing API change.
