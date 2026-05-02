# Robin Autonomous Memory — Design

**Date:** 2026-05-01
**Author:** Kevin (with brainstorming co-pilot)
**Status:** Approved for implementation
**Scope:** `robin-assistant/` package; Claude Code host; user-data is unchanged structurally
**Cost constraint:** No external API key required

## Problem statement

Two failure modes degrade Robin's autonomous memory today:

1. **Capture miss (A).** Mid-conversation and at conversation-end, signals worth remembering are not written to memory. Kevin has to prompt "capture everything" to get Robin to actually run the capture checkpoint. The rule lives in `AGENTS.md` but is a model-discipline instruction, not a system-enforced one.
2. **Recall miss (C).** Stored facts are not surfaced when relevant. The model would have to load the right topic file and apply it without being asked, and often does neither.

Both are rooted in the same architectural issue: capture and recall are *instructions to the model*, not *enforcements by the system*. The model sometimes complies, sometimes doesn't.

## Design principle

**Don't make the model remember; make the system enforce.** Move capture and recall from "the model is supposed to" to "the system makes it happen via Claude Code lifecycle hooks." Both subsystems below follow this principle.

## Subsystem 1 — Capture Enforcement

A hard wall at end-of-turn: if the turn was substantive and the model didn't capture (and didn't explicitly waive), Stop hook blocks the turn-end and re-prompts. Bounded retry. Fail-open on errors.

### Components

#### S1.1 — `UserPromptSubmit` hook handler

New mode in `system/scripts/hooks/claude-code.js`: `--on-user-prompt-submit`.

On every user message:
- Mint `turn_id = <session_id>:<UTC ms>`.
- Word-count the user message.
- Run capture-keyword regex (proper-noun-followed-by-attribution, dates, money amounts, "remember", "decided", "actually", "no — ", any entity name from `ENTITIES.md`).
- Run entity-match regex (subset of capture-keyword scan, restricted to ENTITIES.md aliases).
- If any `type: entity` file or any file with `aliases:` frontmatter has `mtime > ENTITIES.md.mtime` → run incremental update appending the new entity row(s).
- If any entities matched → in-process recall produces a `<!-- relevant memory -->` block (see S2.4).
- Also scan the **most recently emitted complete assistant message** in the transcript for entity matches; merge with user-msg matches (dedup), so follow-ups like "schedule it" inherit entities Robin just mentioned.
- Atomic write `user-data/state/turn.json`:
  ```json
  {"turn_id":"...","started_at":"...","user_words":12,"tier":3,"entities_matched":["dr-park"]}
  ```
- Inject the relevant-memory block (if any) via stdout (Claude Code's `additionalContext` protocol).
- Hard timeout: 80 ms. On timeout, abort gracefully (no injection), append `<ts>\t<hook>\t<duration_ms>\t<reason>` to `user-data/state/hook-perf.log`, exit 0.

#### S1.2 — `Stop` hook capture verifier

New function `verifyCapture(ws)` invoked at the top of `onStop()`, before `writeAutoLine()` and the existing background drain.

Steps:
1. Read `turn.json`. If missing/corrupt → fail-open (pass).
2. Tier classification (already computed in S1.1):
   - **Tier 1** (`user_words < 5` OR pure greeting/ack pattern) → pass.
   - **Tier 2** (`5 ≤ user_words < 20` AND no capture-keyword hits) → light enforcement. Marker accepted without justification.
   - **Tier 3** (`user_words ≥ 20` OR any capture-keyword hit) → full enforcement. Marker requires a one-line reason.
3. Read `user-data/state/turn-writes.log`, filter by `turn_id`, count writes to `user-data/memory/`. ≥1 write → pass.
4. Else read `event.transcript_path` (fallback: derive from `session_id`), tail last 16 KB, regex-scan for `<!-- no-capture-needed: ... -->`. Found and well-formed for tier → pass.
5. Else check `user-data/state/capture-retry.json` for current `turn_id`:
   - `attempts < retry_budget` (default 1) → increment, exit 2 with corrective stderr message.
   - `attempts ≥ retry_budget` → log `skipped: budget exhausted`, append `<!-- capture-skipped -->` to the auto-line, pass.
6. Append one telemetry line to `user-data/state/capture-enforcement.log`: `<ts>\t<turn_id>\t<tier>\t<outcome>` where outcome ∈ `{skipped-trivial, captured, marker-pass, retried-passed, retried-failed, error}`.

Corrective stderr message:
> `Capture before ending the turn. Either (a) write a tagged line to user-data/memory/inbox.md per AGENTS.md capture-rules, or (b) emit "<!-- no-capture-needed: <one-line reason> -->" if nothing in this turn warrants capture. This is enforced; second pass is allowed once.`

#### S1.3 — Write-intent tracking via `PreToolUse`

Extend the existing `--on-pre-tool-use` mode and `--on-pre-bash` mode:
- For `Write`/`Edit`/`NotebookEdit` whose target is under `user-data/memory/`: append `<turn_id>\t<target>\t<tool>` to `user-data/state/turn-writes.log` (atomic append). Existing PII / high-stakes / auto-memory blocks happen first; write-intent log is recorded only on allow path.
- For `Bash` commands matching `>>?\s*[^\s]*user-data/memory/` (covers `>` and `>>` redirections to memory paths, e.g. `echo "..." >> user-data/memory/inbox.md`): same log entry with `tool=bash`. Existing sensitive-pattern check happens first.

This eliminates the need for any filesystem walk or mtime snapshot. Stop verification becomes O(1).

#### S1.4 — State files

| Path | Owner | Lifecycle |
|---|---|---|
| `user-data/state/turn.json` | UserPromptSubmit (write) / Stop (read) | Overwritten per turn; cleared at SessionStart > 6 h old |
| `user-data/state/turn-writes.log` | PreToolUse (append) / Stop (read+prune) | Stop rewrites in-place keeping entries with `ts > now - 1h` at end-of-turn; SessionStart caps file at 1000 lines |
| `user-data/state/capture-retry.json` | Stop (read+write) | Per `turn_id`; SessionStart clears entries > 6 h old |
| `user-data/state/capture-enforcement.log` | Stop (append) | Capped 5000 lines; Dream Phase 4.17.7 rotates |
| `user-data/state/hook-perf.log` | Any hook (append on slow-path) | Capped 1000 lines; Dream rotates |

All writes atomic (temp + rename or `O_APPEND` + flock).

#### S1.5 — Triviality filter config

`user-data/robin.config.json → memory.capture_enforcement`:
```json
{
  "enabled": true,
  "min_user_words_tier2": 5,
  "min_user_words_tier3": 20,
  "retry_budget": 1
}
```
- Disable via env var `ROBIN_CAPTURE_ENFORCEMENT=off` (checked before config) for fast escape from a shell.
- All thresholds tunable.

#### S1.6 — `AGENTS.md` and `system/rules/capture.md` updates

`AGENTS.md` "Capture checkpoint" block becomes:
> After every response, scan for capturable signals.
> - **Direct-write to file** (don't just acknowledge — actually save): corrections → `user-data/memory/self-improvement/corrections.md`; "remember this" → relevant file + confirm; updates that supersede an in-context fact → update in place.
> - **Inbox-write** with `[tag|origin=...]` to `user-data/memory/inbox.md` for everything else.
> - **Capture is enforced at turn-end.** Either write to `inbox.md` / direct-write file, or emit `<!-- no-capture-needed: <one-line reason> -->`. Failing both blocks turn-end with one retry.
> - **Tags:** `[fact|origin=...|preference|decision|correction|task|update|derived|journal|predict|?]`. Same origin rules as before.

Net token delta: ~+20 tokens (new enforcement line); ~-50 tokens from removing T1 sweep instruction in `capture-rules.md`. Net savings on every turn forever.

`capture-rules.md` changes:
- Drop the T1 (~20-turn) mid-session sweep section. Keep T2 (graceful end) and T3 (Stop hook auto-line).
- Add a "Marker protocol" subsection documenting `<!-- no-capture-needed: <reason> -->` syntax and retry semantics.

#### S1.7 — `.claude/settings.json` registration

Register `UserPromptSubmit` hook entry pointing at `node system/scripts/hooks/claude-code.js --on-user-prompt-submit`. Keep all existing entries.

#### S1.8 — `system/scripts/cli/install-hooks.js` updates

- Idempotent registration of the new `UserPromptSubmit` matcher + command.
- Atomic `settings.json` write (temp + rename).
- Re-run `manifest-snapshot.js` after registration so `check-manifest.js` doesn't flag drift on next SessionStart.

#### S1.9 — `user-data/security/manifest.json` update

Add the new hook to the manifest baseline. Done as part of the install run.

## Subsystem 2 — Recall

Two pieces: an auto-generated `ENTITIES.md` index and an auto-recall hook that injects relevant memory into the model's context based on entity matches in the user message. Same architectural pattern as Subsystem 1: don't ask the model to remember; have the system surface relevant memory automatically.

### Components

#### S2.1 — `user-data/memory/ENTITIES.md`

Auto-generated index, hot-cache-friendly. Format:
```markdown
---
description: Auto-generated entity index for fast recall lookup
type: reference
generated: 2026-05-01T04:00:00Z
---
# Entities

<!-- DO NOT EDIT — auto-generated by Dream Phase 4.17.6.
     Edit topic-file aliases instead. -->

- Dr. Park (dentist) — knowledge/medical/providers.md#dr-park
- Marcus HYSA (Marcus, Goldman Sachs HYSA) — knowledge/finance/marcus.md
- Z f Orange (Nikon Z f) — knowledge/photo-gear-inventory.md#z-f
- ...
```

- **Cap:** ~150 rows / ~1.2 k tokens for the hot file. Overflow → `ENTITIES-extended.md` (loaded on demand by `recall` and the auto-recall hook only).
- **Hot/extended split sort:** by hit-frequency in `recall.log` (descending), tie-broken alphabetically. Dream computes the cut.
- **Edit safety:** generation script aborts with clear error if user edits below the marker (compares against `user-data/state/entities-hash.txt`); existing file kept; surfaced in dream summary.
- **Atomic write:** `.tmp` + fsync + rename.

#### S2.2 — Frontmatter conventions on entity-bearing files

Any file whose frontmatter contains `aliases:` contributes to ENTITIES.md, regardless of `type:`:

```yaml
---
description: Goldman Sachs Marcus HYSA — primary savings account
type: entity              # optional; signals dedicated entity file
aliases: [Marcus, GS HYSA]
disambiguator: [hysa, savings, account, goldman]   # required for aliases ≤2 tokens
---
```

- Aliases ≥3 tokens or unique strings: indexed directly.
- Aliases ≤2 tokens (e.g., "Marcus"): require `disambiguator:` field; matcher requires one of the disambiguator words within ±15 tokens of the alias hit. Without disambiguator, alias is skipped (logged to `recall.log`).
- Files with `entity_root: true` (whitelist; default false): each `## Subsection` heading also contributes a row. Only enabled on a small set of explicitly-curated files (`profile/people.md`, `knowledge/medical/providers.md`, etc.).

#### S2.3 — `system/scripts/memory/index-entities.js`

Generation script.

- **`--bootstrap` mode:** one-shot at install/upgrade. Discovers entities from existing structure (every standalone topic file under `profile/people/`, `knowledge/medical/providers/`, `knowledge/finance/`, etc.). Writes ENTITIES.md and prints a list of files where it'd help to add `aliases:` or `disambiguator:`. Non-blocking.
- **`--regenerate` mode:** invoked by Dream Phase 4.17.6 (after LINKS.md, before compact-summary). Idempotent — content-hash compare, no-op when unchanged. Atomic write.
- **Cost:** <500 ms over typical memory tree.

#### S2.4 — `system/scripts/memory/lib/recall.js` (shared lib)

Node-native retrieval:
- `fs.readdir` walk + substring match over `user-data/memory/**/*.md`. MB-scale, no external dependencies (no `rg`).
- Multi-pattern: compiled regex alternation `\b(p1|p2|...)\b` with smart-case.
- Output per match: `<file:line>: <line text>`, plus 1-line context when available, plus `last_verified:` from frontmatter when present.
- Caps: top-5 hits per query, ~200 tokens total.
- Latency: <30 ms typical.
- Returns structured object `{hits: [...], truncated: bool}` for in-process callers; CLI wrapper formats as text.

#### S2.5 — `bin/robin.js recall <query>` subcommand

- CLI wrapper around `lib/recall.js`.
- `--json` flag for programmatic consumers.
- Exit 0 always (empty result is informative).
- Used by humans for quick lookups; **NOT** called by the auto-recall hook (hook uses the lib directly to avoid spawn cost).

#### S2.6 — Auto-recall in `UserPromptSubmit`

Already part of S1.1. Specific behavior:

- After capture-keyword + entity-match scan, for each matched entity (cap: 5), call `lib/recall.js` in-process with the entity's primary name + aliases.
- Build the injection block:
  ```
  <!-- relevant memory (auto-loaded based on entities in your message) -->
  - Dr. Park: knowledge/medical/providers.md:42 — "Dentist, Hoboken, last visit 2026-01" (last_verified: 2026-01)
  - Marcus HYSA: knowledge/finance/marcus.md:8 — "$10k balance, 5.0% APY" (last_verified: 2025-11)
  <!-- /relevant memory -->
  ```
- Hard caps: 5 entities × 3 hits × ~50 tokens ≈ 750 tokens. Absolute ceiling 1 k tokens. Above cap → truncate, append `(N more matches; run "recall <term>" for full)`.
- Empty match → emit nothing (no overhead).
- Append one telemetry line to `recall.log`: `<ts>\t<turn_id>\t<entities_matched>\t<hits_injected>\t<bytes_injected>`.

#### S2.7 — `AGENTS.md` update

Add one line under "Operational Rules":
> For questions about a specific person/thing/topic, prefer `recall <term>` over guessing if the relevant file isn't already loaded. Auto-recall context blocks (`<!-- relevant memory -->`) are pre-populated for entities mentioned in the user message — read them first.

Net delta: ~+30 tokens.

#### S2.8 — Startup load order

`AGENTS.md` step 4 read order becomes:
```
INDEX.md → ENTITIES.md → profile/identity.md → profile/personality.md → ...
```
ENTITIES.md slots immediately after INDEX.md because both regenerate during Dream and invalidate the prompt cache together; nothing downstream is harmed by the daily change.

#### S2.9 — Dream integration

- **Phase 4 step 17.6 — ENTITIES.md regeneration.** Runs after LINKS.md (17), before compact-summary (17.5). Calls `index-entities.js --regenerate`. Idempotent.
- **Phase 4 step 17.7 — telemetry log rotation.** Trims `capture-enforcement.log`, `recall.log`, `hook-perf.log` to 5000 lines each (or 1000 for hook-perf).
- **Phase 3 step 11.5 — capture + recall telemetry review.** Reads the rotated logs since `last_dream_at`; surfaces in escalation report:
  - "Capture enforcement misfired N times this week (top reason: ...)."
  - "Auto-recall avg injection: X tokens; trend: rising/stable/falling."
  - "M frequently-matched entities route to nothing (consider creating files)."
  - "K aliases skipped due to missing disambiguator."

## Data flow

### Per-turn capture flow

```
User submits message
    │
    ▼
UserPromptSubmit hook  (≤80 ms hard timeout)
    ├─ mint turn_id
    ├─ word count + capture-keyword scan + entity scan
    ├─ if entity-files newer than ENTITIES.md → incremental update
    ├─ if entities matched → in-process recall → build relevant-memory block
    ├─ also scan last assistant message in transcript (dedup)
    ├─ write turn.json
    └─ inject relevant-memory block via stdout
        │
        ▼
Model processes turn
    │
    ├─ Direct-write to memory file
    │     └─ PreToolUse appends to turn-writes.log
    ├─ Append to inbox.md
    │     └─ PreToolUse appends to turn-writes.log
    ├─ Bash >> inbox.md
    │     └─ PreToolUse(Bash) appends to turn-writes.log
    └─ (optional) emit <!-- no-capture-needed: ... --> in response
        │
        ▼
Stop hook
    ├─ verifyCapture():
    │     ├─ read turn.json (fail-open if missing)
    │     ├─ tier 1 → pass
    │     ├─ tier 2/3 → read turn-writes.log filtered by turn_id
    │     │     ├─ writes ≥ 1 → pass
    │     │     ├─ writes = 0 + transcript-tail marker found → pass
    │     │     ├─ writes = 0 + no marker + retries < budget → exit 2
    │     │     └─ writes = 0 + retries ≥ budget → log skipped, pass
    │     ├─ append capture-enforcement.log
    │     └─ prune turn-writes.log to last hour
    ├─ writeAutoLine()       (existing)
    └─ drain auto-memory     (existing, background)
```

### Per-turn recall flow

Inlined in capture flow above (S1.1 step). Model can also call `recall <term>` mid-turn for queries that don't match auto-loaded entities.

## Failure modes & handling

| Failure | Behavior |
|---|---|
| Hook script throws | Top-level try/catch, fail-open, log to `state/hook-errors.log` |
| `turn.json` missing/corrupt | Stop assumes tier-1 trivial, passes |
| `turn-writes.log` corrupt | Stop falls back to checking inbox.md mtime only |
| `capture-retry.json` corrupt | Treat as no retries used; allows one re-prompt; passes thereafter |
| Transcript path missing | Skip marker scan; if retries available, retry; else log+pass |
| ENTITIES.md missing | Auto-recall hook skips silently; `recall` CLI still works |
| ENTITIES.md user-edited (post-marker) | Regen aborts with clear error; existing file kept; surfaced in dream summary |
| `bin/robin.js` not on PATH | `recall` CLI unavailable; auto-recall via hook still works (in-process lib) |
| Multi-session concurrent UserPromptSubmit/Stop | `turn_id` ms-precision avoids collision |
| Hourly cron writes during a turn | Drain doesn't go through tool layer → not in turn-writes.log → no false positive |
| User disables enforcement | `ROBIN_CAPTURE_ENFORCEMENT=off` env var or `robin.config.json` flag → all checks pass silently |
| Manifest tamper-detection drift | `install-hooks.js` re-snapshots manifest after registering new hooks |
| `robin update` runs mid-session | settings.json write is atomic; in-flight hooks complete with old code |
| UserPromptSubmit exceeds 80 ms | Abort gracefully, no injection, log to hook-perf.log |

## Performance + cost summary

| Path | Cost |
|---|---|
| UserPromptSubmit (no entities matched) | ~5–10 ms |
| UserPromptSubmit (5 entities matched, in-process recall) | ~25–40 ms |
| UserPromptSubmit (incremental ENTITIES update needed) | +10 ms |
| PreToolUse memory write | +0.5 ms |
| Stop verify (captured) | ~2 ms |
| Stop verify (no-capture, marker present) | ~5–10 ms |
| Stop verify (misfire retry) | ~$0.005 per miss (200–400 tokens) |
| Per-turn token addition (default) | 0 in response, ~10 in system prompt |
| Per-turn token addition (auto-recall match) | up to 1k injected (capped); avg ~300–500 |
| Net savings (T1 sweep removal) | ~80 tokens/turn forever |

**Net per-turn cost (typical):** small spend on recall-injection paths in exchange for major reliability gains; net token *savings* on all paths from removing the T1 sweep.

## Testing

### Unit tests (`system/tests/`, `node --test`)

- `claude-code-hook.test.js`:
  - UserPromptSubmit: turn_id minting, tier classification, entity scan, auto-recall injection, 80 ms timeout
  - Stop verifyCapture: each tier behavior, retry budget, marker detection, telemetry write
  - Fail-open paths: throw inside any hook returns exit 0
  - PreToolUse write-intent log: append correctness, atomicity, Bash matcher
- `index-entities.test.js`:
  - Bootstrap mode: discovers entities from sample memory tree
  - Regenerate mode: idempotent (no-op when content identical)
  - Edit-detection: aborts when user-edits detected
  - Hot/extended split at 150-row cap, sorted by hit-frequency
  - Atomic write semantics (interrupted regen leaves prior file intact)
- `recall.test.js`:
  - In-process search returns expected hits with correct format
  - `last_verified:` extraction
  - Multi-pattern search dedup
  - Disambiguator gating for short aliases
  - Empty result returns clean output
  - Caps enforcement (top-5 hits, ~200 tokens)
- `capture-keyword-scan.test.js`: tier classification across a corpus of representative user messages

### Integration tests

- `golden-session-capture.js`: replays a synthetic 10-turn conversation. Asserts:
  - Trivial turns pass without enforcement
  - Substantive turns capture or block-and-retry
  - Auto-recall injection content matches expected entities
  - `capture-enforcement.log` + `recall.log` have expected entries
- `dream-entities.test.js`: Dream runs with sample memory tree; asserts ENTITIES.md regenerated correctly, telemetry logs processed, log files rotated.

### Test fixtures

`system/tests/fixtures/mock-hook-events/` contains sample JSON payloads for `UserPromptSubmit`, `Stop`, `PreToolUse(Write)`, `PreToolUse(Bash)`. Tests pipe these to the hook script and assert exit codes + side effects.

### Manual verification

Before merging:
- Run a real session, verify auto-recall injection visible in transcript, capture hard-wall fires once, retry succeeds.
- Run `npm run measure-tokens` before/after; expect net savings from removed T1 sweep.
- Update `token-baselines.json` with new fields: `capture_enforcement_overhead`, `auto_recall_injection_avg`.

## Migration / rollout

1. Land code + tests behind `memory.capture_enforcement.enabled = false`.
2. Run `node system/scripts/cli/install-hooks.js` to register the new `UserPromptSubmit` handler and re-snapshot manifest.
3. Run `node system/scripts/memory/index-entities.js --bootstrap`. Review the "files would benefit from explicit aliases" report; backfill the most important entries.
4. Flip `enabled = true` in `robin.config.json`.
5. Watch `capture-enforcement.log` and `recall.log` over the first week.
6. Tune triviality thresholds if misfire rate is high.

Rollback: set env var `ROBIN_CAPTURE_ENFORCEMENT=off` or flip the config flag.

## Explicit non-goals (YAGNI)

- **No vector embeddings.** Plain markdown + grep stays the substrate.
- **No cross-host parity.** Cursor / Gemini / Codex enforcement is Phase 2.
- **No mid-session sweep at 20 turns.** Per-turn enforcement supersedes T1.
- **No LLM-driven capture.** No API key required. Subsystem 1 is purely deterministic.
- **No topic-keyword auto-recall.** Entity-only in v1; INDEX-keyword scanning deferred.
- **No automatic entity-file creation.** Dream surfaces "frequently-matched entities with no file"; user creates the file.
- **No history rewrite.** Existing inbox.md, journal.md, etc. unchanged. New behavior applies forward only.
- **No Dream rewrite.** Dream gets two new phase steps (11.5, 17.6, 17.7); the rest is untouched.

## Open questions

None at design time. Resolve during implementation:
- Final regex shape for capture-keywords (start with the conservative list documented in S1.1; tune from telemetry).
- Final disambiguator-window size (start at ±15 tokens; tune if false-positives surface).

## Files touched (forecast)

**New:**
- `system/scripts/memory/index-entities.js`
- `system/scripts/memory/lib/recall.js`
- `system/scripts/capture/lib/capture-keyword-scan.js`
- `system/tests/claude-code-hook.test.js` (extends existing tests if any)
- `system/tests/index-entities.test.js`
- `system/tests/recall.test.js`
- `system/tests/capture-keyword-scan.test.js`
- `system/tests/fixtures/mock-hook-events/*.json`
- `system/scripts/jobs/golden-session-capture.js`
- `user-data/memory/ENTITIES.md` (generated)

**Modified:**
- `system/scripts/hooks/claude-code.js` (new modes + verifyCapture)
- `system/scripts/cli/install-hooks.js` (new hook registration, atomic write)
- `system/scripts/diagnostics/manifest-snapshot.js` (re-run after install)
- `bin/robin.js` (new `recall` subcommand)
- `AGENTS.md` (capture-checkpoint update + recall instruction)
- `system/rules/capture.md` (drop T1, add marker protocol section)
- `system/jobs/dream.md` (new Phase 3.11.5, 4.17.6, 4.17.7 steps)
- `system/scripts/diagnostics/lib/token-baselines.json` (new baseline fields)
- `user-data/security/manifest.json` (new hook in baseline)
- `.claude/settings.json` (new UserPromptSubmit hook entry)
- `user-data/robin.config.json` (new `memory.capture_enforcement` block)
- `CHANGELOG.md` (entry)
