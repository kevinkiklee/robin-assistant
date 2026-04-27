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

All steps run every dream. Steps with nothing to do are no-ops. Priority order determines what's complete if Dream is interrupted.

5. **Correction promotion** — if a mistake type appears 2+ times in `## Corrections`, promote to `## Patterns` with recognition signals and counter-action. Remove the original correction entries.

6. **Pattern review** — for each existing pattern in `## Patterns`, check recent corrections and journal entries: is the counter-action working? If the same mistake keeps recurring despite the pattern, ESCALATE so the user knows the current counter-action isn't effective.

7. **Session reflection processing** — scan `## Session Reflections` written since last dream. Extract knowledge gaps and add to `## Learning Queue`. Note domains touched and feed into `## Domain Confidence`. Prune reflections older than 30 days.

8. **Preference promotion** — scan `## Preferences` for dimensions with 3+ consistent signals. Promote to `## Communication Style` (base style or domain override as appropriate). Check for contradictions between recent signals and established preferences — update or narrow stale preferences. Flag unresolvable contradictions in escalation report.

9. **Domain confidence update** — review session reflections, effectiveness scores, and corrections since last dream. Adjust confidence levels. Decay any domain not touched in 90+ days by one level (high→medium; medium stays).

10. **Learning queue maintenance** — add items from knowledge gaps in session reflections. Scan recent journal entries and session handoffs for organically answered questions — mark them answered. Drop items older than 60 days that never found a natural moment.

11. **Calibration update** — update prediction accuracy for matured predictions. Update effectiveness scores where outcomes can be inferred from recent sessions (user follow-up, contradictory actions, or 30+ days of silence → unknown). Disagreement/sycophancy check.

12. **Session handoff cleanup** — entries in `## Session Handoff` older than 14 days -> archive to `journal.md` or delete if resolved.

## Boundary rule

Dream can read and write any of the 8 core data files (profile.md, tasks.md, knowledge.md, decisions.md, journal.md, self-improvement.md, inbox.md).

Dream manages its own `state/locks/dream.lock` (create/delete) but NEVER edits other lock files.

Dream NEVER edits: `AGENTS.md`, `protocols/`, `integrations.md`, `startup.md`, `capture-rules.md`, `robin.config.json`.

Dream NEVER runs external commands or makes network requests.

## Output

### Default (silent)

One-line summary: "Dreamt: pruned N tasks, routed M from inbox, promoted K facts, processed L reflections, reviewed P patterns."

### Escalation report

Triggered by: unresolvable contradictions, ambiguous inbox items, time-sensitive routed items, ineffective patterns, preference contradictions, calibration drift, sycophancy signals, or errors. Present under a `## Needs your input` heading. Neutral, factual tone.

## Failure modes

- Lock held -> skip cleanly
- Error mid-phase -> mark status: partial, release lock, escalate
- If `state/dream-state.md` is corrupted -> recreate baseline, skip this run
