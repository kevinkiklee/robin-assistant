# Protocol: Dream

Daily automatic maintenance that keeps Robin's memory organized and its behavior improving. Runs once per day at session startup.

Two jobs: **memory management** (route, promote, and prune stored facts) and **self-improvement** (turn corrections into patterns, update calibration, clean up handoff notes).

## Triggers

Automatic only — invoked from `startup.md`. Never invoked manually.

## Eligibility check

Run after session registration, before reading `profile.md`.

1. Read `state/dream-state.md`.
   - File missing or `status: fresh-install` -> create baseline (status: baseline-only, last_dream_at=now), write file, SKIP.
2. Skip checks (any -> SKIP):
   - 2+ other sessions listed as active in `state/sessions.md`
3. Eligibility:
   - elapsed = now - last_dream_at
   - eligible = elapsed >= 24h
   - Not eligible -> SKIP
4. Eligible -> acquire `state/locks/dream.lock` (follow lock protocol in `protocols/multi-session-coordination.md`).
   - Lock held -> SKIP
   - Lock acquired -> proceed to phases

After running (whether complete or partial), always:
- Delete `state/locks/dream.lock`
- Update `state/dream-state.md`: last_dream_at=now
- Print one-line summary OR escalation report

## Phase 1: Scan

Read these files:
- `state/dream-state.md` (for `last_dream_at` timestamp)
- `journal.md` — entries dated after `last_dream_at`
- `inbox.md` — all unprocessed entries
- `tasks.md` — completed or stale items
- `self-improvement.md` — all sections (corrections, patterns, session handoff, calibration)
- `decisions.md` — decisions older than 30 days with no recorded outcome

## Phase 2: Memory management

1. **Inbox routing** — for each entry in `inbox.md`:
   - Classify per `capture-rules.md` routing table
   - Confident match -> move to destination file, delete from inbox
   - Ambiguous -> leave in inbox, ESCALATE
   - Time-sensitive (deadline <=14d) -> route AND ESCALATE

2. **Fact promotion** — durable facts in `journal.md` entries (e.g., "got a new doctor: Dr. Smith") -> promote to `profile.md` or `knowledge.md`.

3. **Task pruning** — completed tasks older than 60 days -> remove. Stale tasks (no activity >30 days) -> flag for user review at next interaction.

4. **Profile and knowledge freshness** — skim `profile.md` and `knowledge.md` for information that contradicts recent journal entries or conversation context. Flag stale facts for user review.

## Phase 3: Self-improvement

5. **Correction promotion** — if a mistake type appears 2+ times in `## Corrections`, promote to `## Patterns` with recognition signals and counter-action. Remove the original correction entries.

6. **Pattern review** — for each existing pattern in `## Patterns`, check recent corrections and journal entries: is the counter-action working? If the same mistake keeps recurring despite the pattern, ESCALATE so the user knows the current counter-action isn't effective.

7. **Calibration update** — read `## Calibration`. For any verifiable predictions that have matured (outcome now known), update accuracy. Flag drift if a confidence band is consistently over- or under-confident.

8. **Session handoff cleanup** — entries in `## Session Handoff` older than 14 days -> archive to `journal.md` or delete if resolved.

9. **Disagreement check** — review corrections and journal entries since last dream. If there are zero instances of Robin pushing back on the user's stated intent, note this in `## Calibration` as a sycophancy signal.

## Boundary rule

Dream can read and write any of the 8 core data files (profile.md, tasks.md, knowledge.md, decisions.md, journal.md, self-improvement.md, inbox.md).

Dream manages its own `state/locks/dream.lock` (create/delete) but NEVER edits other lock files.

Dream NEVER edits: `AGENTS.md`, `protocols/`, `integrations.md`, `startup.md`, `capture-rules.md`, `robin.config.json`.

Dream NEVER runs external commands or makes network requests.

## Output

### Default (silent)

One-line summary: "Dreamt: pruned N tasks, routed M from inbox, promoted K facts, reviewed L patterns."

### Escalation report

Triggered by: unresolvable contradictions, ambiguous inbox items, time-sensitive routed items, ineffective patterns, calibration drift, sycophancy signals, or errors. Present under a `## Needs your input` heading. Neutral, factual tone.

## Failure modes

- Lock held -> skip cleanly
- Error mid-phase -> mark status: partial, release lock, escalate
- If `state/dream-state.md` is corrupted -> recreate baseline, skip this run
