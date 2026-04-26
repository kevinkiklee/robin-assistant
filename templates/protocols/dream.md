# Protocol: Dream

Lightweight automatic memory consolidation. Runs at session startup when conditions are met.

## Triggers

Automatic only — invoked from `startup.md`. Never invoked manually.

## Eligibility check

Run after session registration, before reading `profile.md`.

1. Read `state/dream-state.md`.
   - File missing or `status: fresh-install` -> create baseline (status: baseline-only, last_dream_at=now, sessions_since=0), write file, SKIP.
2. Increment `sessions_since` by 1, write back to `state/dream-state.md`.
3. Skip checks (any -> SKIP, do not reset counter):
   - 2+ other sessions listed as active in `state/sessions.md`
4. Eligibility:
   - elapsed = now - last_dream_at
   - eligible = (elapsed >= 24h AND sessions_since >= 5) OR (elapsed >= 72h)
   - Not eligible -> SKIP
5. Eligible -> acquire `state/locks/dream.lock` (follow lock protocol in `protocols/multi-session-coordination.md`).
   - Lock held -> SKIP (do not reset counter)
   - Lock acquired -> proceed to phases

After running (whether complete or partial), always:
- Delete `state/locks/dream.lock`
- Update `state/dream-state.md`: last_dream_at=now, sessions_since=0
- Print one-line summary OR escalation report

## Phase 1: Scan

Read these files:
- `state/dream-state.md` (for `last_dream_at` timestamp)
- `journal.md` — identify entries dated after `last_dream_at`
- `inbox.md` — identify all unprocessed entries
- `tasks.md` — scan for completed or stale items
- `self-improvement.md` — read session handoff section

## Phase 2: Consolidate

For each item identified in the scan:

1. **Inbox routing** — for each entry in `inbox.md`:
   - Classify per `capture-rules.md` routing table
   - Confident match -> move to destination file, delete from inbox
   - Ambiguous -> leave in inbox, ESCALATE
   - Time-sensitive (deadline <=14d) -> route AND ESCALATE

2. **Fact promotion** — durable facts in `journal.md` entries (e.g., "got a new doctor: Dr. Smith") -> promote to `profile.md` or `knowledge.md`.

3. **Task pruning** — completed tasks older than 60 days -> remove. Stale tasks (no activity >30 days) -> flag for user review at next interaction.

4. **Session handoff cleanup** — entries in `self-improvement.md` -> `## Session Handoff` older than 14 days -> archive to `journal.md` or delete if resolved.

5. **Correction promotion** — if a mistake type appears 2+ times in `## Corrections`, add to `## Patterns` with recognition signals and counter-action.

## Boundary rule

Dream can read and write any of the 8 core data files (profile.md, tasks.md, knowledge.md, decisions.md, journal.md, self-improvement.md, inbox.md).

Dream manages its own `state/locks/dream.lock` (create/delete) but NEVER edits other lock files.

Dream NEVER edits: `AGENTS.md`, `protocols/`, `integrations.md`, `startup.md`, `capture-rules.md`, `robin.config.json`.

Dream NEVER runs external commands or makes network requests.

## Output

### Default (silent)

One-line summary: "Dreamt: pruned N items, routed M from inbox, promoted K facts."

### Escalation report

Triggered by: unresolvable contradictions, ambiguous inbox items, time-sensitive routed items, or errors. Present under a `## Needs your input` heading. Neutral, factual tone.

## Failure modes

- Lock held -> skip cleanly, do not reset counter
- Error mid-phase -> mark status: partial, release lock, escalate
- If `state/dream-state.md` is corrupted -> recreate baseline, skip this run
