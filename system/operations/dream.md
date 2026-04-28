---
name: dream
triggers: ["dream", "memory check", "daily maintenance"]
description: Daily automatic maintenance that runs at session startup; runs startup-check pre-flight, then routes inbox, promotes facts, prunes tasks, processes self-improvement signals, and reconciles indexes.
---
# Protocol: Dream

Daily automatic maintenance that keeps Robin's memory organized and its behavior improving. Runs once per day at session startup.

## Pre-flight

Before any Dream phase runs, invoke `node system/scripts/startup-check.js` and read its output line-by-line.

- On any line starting with `FATAL:`, surface the message to the user and abort Dream — do not proceed to the eligibility check or any phase.
- On `INFO:` and `WARN:` lines, include them in your one-line summary or escalation report at the end of the run.

The startup check performs limited auto-repair before reporting:
- **Skeleton sync** — files present in `system/skeleton/` but missing from `user-data/` are copied automatically; the new paths are reported as `INFO: new files from upstream: ...`.
- **Stale lock cleanup** — locks in `user-data/state/locks/` older than 5 minutes are cleared automatically; cleared locks are reported as `INFO: cleared stale lock: ...`.

Anything outside that scope (corrupted config, failed migrations, validation failures, missing core files) is reported but NOT auto-repaired — it surfaces as `WARN:` or `FATAL:` for the user to address.

After pre-flight succeeds, continue with the eligibility check below.

Two jobs: **memory management** (route, promote, and prune stored facts) and **self-improvement** (turn corrections into patterns, update calibration, clean up handoff notes).

## Triggers

Automatic only — invoked from `system/startup.md`. Never invoked manually.

## Eligibility check

Run after session registration, before reading the memory tree.

1. Read `user-data/state/dream-state.md`.
   - File missing or `status: fresh-install` -> create baseline (status: baseline-only, last_dream_at=now), write file, SKIP.
2. Skip checks (any -> SKIP):
   - 2+ other sessions listed as active in `user-data/state/sessions.md`
3. Eligibility:
   - elapsed = now - last_dream_at
   - eligible = elapsed >= 24h
   - Not eligible -> SKIP
4. Eligible -> acquire `user-data/state/locks/dream.lock` (follow lock protocol in `system/operations/multi-session-coordination.md`).
   - Lock held -> SKIP
   - Lock acquired -> proceed to phases

After running (whether complete or partial), always:
- Delete `user-data/state/locks/dream.lock`
- Update `user-data/state/dream-state.md`: last_dream_at=now
- Print one-line summary OR escalation report

## Phase 1: Scan

Read these files:
- `user-data/state/dream-state.md` (for `last_dream_at` timestamp)
- `user-data/memory/journal.md` — entries dated after `last_dream_at`
- `user-data/memory/inbox.md` — all unprocessed entries
- `user-data/memory/tasks.md` — completed or stale items
- `user-data/memory/self-improvement.md` — all sections (corrections, patterns, session handoff, calibration)
- `user-data/memory/decisions.md` — decisions older than 30 days with no recorded outcome

## Phase 2: Memory management

1. **Inbox routing** — for each entry in `user-data/memory/inbox.md`:
   - If the entry has a tag (e.g., `[fact]`, `[preference]`), use it as a first-pass routing signal. Verify against `system/capture-rules.md` routing table — tags are hints, not binding.
   - `[?]` tagged entries: treat as unclassified, classify from content.
   - `[update]` tagged entries: use `(supersedes: <hint>)` if present to locate the original entry. Update the original, then remove the inbox item.
   - Untagged entries: classify per `system/capture-rules.md` routing table.
   - Consult `user-data/memory/INDEX.md` to pick the destination topic file. Insert under the matching `## ` subsection if one exists.
   - **Dream is the only writer that creates new topic files for inbox-routed content.** If no topic file fits, create one with `description:` frontmatter inferred from the entry; the next index regen picks it up.
   - Confident match -> move to destination file, delete from inbox
   - Ambiguous -> leave in inbox, ESCALATE
   - Time-sensitive (deadline <=14d) -> route AND ESCALATE

2. **Fact promotion** — durable facts in `user-data/memory/journal.md` entries (e.g., "got a new doctor: Dr. Smith") -> promote to the matching topic file under `user-data/memory/profile/` or `user-data/memory/knowledge/`.

3. **Task pruning** — completed tasks older than 60 days -> remove. Stale tasks (no activity >30 days) -> flag for user review at next interaction.

4. **Profile and knowledge freshness** — skim topic files under `user-data/memory/profile/` and `user-data/memory/knowledge/` for information that contradicts recent journal entries or conversation context. Flag stale facts for user review.

## Phase 3: Self-improvement

All steps run every dream. Steps with nothing to do are no-ops. Priority order determines what's complete if Dream is interrupted.

5. **Correction promotion** — if a mistake type appears 2+ times in `## Corrections`, promote to `## Patterns` with recognition signals and counter-action. Remove the original correction entries.

6. **Pattern review** — for each existing pattern in `## Patterns`, check recent corrections and journal entries: is the counter-action working? If the same mistake keeps recurring despite the pattern, ESCALATE so the user knows the current counter-action isn't effective.

7. **Session reflection processing** — scan `## Session Reflections` written since last dream. Also scan `## Session Handoff` for capture sweep summaries ("Captured N items to inbox...") — these are data points about session capture quality. Extract knowledge gaps and add to `## Learning Queue`. Note domains touched and feed into `## Domain Confidence`. Prune reflections older than 30 days.

8. **Preference promotion** — scan `## Preferences` for dimensions with 3+ consistent signals. Promote to `## Communication Style` (base style or domain override as appropriate). Check for contradictions between recent signals and established preferences — update or narrow stale preferences. Flag unresolvable contradictions in escalation report.

9. **Domain confidence update** — review session reflections, effectiveness scores, and corrections since last dream. Adjust confidence levels. Decay any domain not touched in 90+ days by one level (high→medium; medium stays).

10. **Learning queue maintenance** — add items from knowledge gaps in session reflections. Scan recent journal entries and session handoffs for organically answered questions — mark them answered. Drop items older than 60 days that never found a natural moment.

11. **Calibration update** — update prediction accuracy for matured predictions. Update effectiveness scores where outcomes can be inferred from recent sessions (user follow-up, contradictory actions, or 30+ days of silence → unknown). Disagreement/sycophancy check.

12. **Session handoff cleanup** — entries in `## Session Handoff` older than 14 days -> archive to `user-data/memory/journal.md` or delete if resolved.

## Phase 4: Memory tree maintenance

Runs after all other phases. Maintains the memory tree structure.

13. **Threshold splitting** — walk the memory tree. For each topic file under `profile/`, `knowledge/`, or `events/`, run `planSplit` from `system/scripts/lib/memory-index.js` with the threshold from `user-data/robin.config.json` (`memory.split_threshold_lines`, default 200). For any file with a non-null plan: write the children to `<parent-dir>/<parent-stem>/<slug>.md`, delete the parent file, then run a memory-tree-wide search-and-replace updating inbound markdown links from the old path to each child. **Exempt files** (never split): `decisions.md`, `journal.md` (append-only logs read by date range), and top-level `knowledge.md` / `profile.md` if they still exist as monoliths (run `npm run split-monoliths` for those).

14. **Empty-file cleanup** — any topic file that is empty (frontmatter only or no content) is deleted. Any topic folder that ends up empty is removed.

15. **Index regeneration** — run `node system/scripts/regenerate-memory-index.js` to rebuild `user-data/memory/INDEX.md` from per-file frontmatter. Idempotent — exits clean if nothing changed.

## Boundary rule

Dream can read and write any topic file under `user-data/memory/` and the flat files (`tasks.md`, `decisions.md`, `journal.md`, `self-improvement.md`, `inbox.md`).

Dream maintains `user-data/memory/INDEX.md` via `regenerate-memory-index.js` (Phase 4 step 15).

Dream manages its own `user-data/state/locks/dream.lock` (create/delete) but NEVER edits other lock files.

Dream NEVER edits: `AGENTS.md`, `system/operations/`, `user-data/integrations.md`, `system/startup.md`, `system/capture-rules.md`, `user-data/robin.config.json`.

Dream NEVER runs external commands or makes network requests.

## Output

### Default (silent)

One-line summary: "Dreamt: pruned N tasks, routed M from inbox, promoted K facts, processed L reflections, reviewed P patterns, split S topic files, regenerated INDEX."

### Escalation report

Triggered by: unresolvable contradictions, ambiguous inbox items, time-sensitive routed items, ineffective patterns, preference contradictions, calibration drift, sycophancy signals, or errors. Present under a `## Needs your input` heading. Neutral, factual tone.

## Failure modes

- Lock held -> skip cleanly
- Error mid-phase -> mark status: partial, release lock, escalate
- If `user-data/state/dream-state.md` is corrupted -> recreate baseline, skip this run
