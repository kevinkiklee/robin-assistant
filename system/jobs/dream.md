---
name: dream
triggers: ["dream", "memory check", "daily maintenance"]
description: Daily memory routing, fact promotion, pattern review, and index maintenance.
runtime: agent
schedule: "0 4 * * *"
enabled: true
catch_up: true
timeout_minutes: 30
notify_on_failure: true
---
# Protocol: Dream

Daily maintenance that keeps Robin's memory organized and its behavior improving.

Two jobs: **memory management** (route, promote, and prune stored facts) and **self-improvement** (turn corrections into patterns, update calibration, clean up handoff notes).

## Invocation

Dream runs in two ways:
- **Scheduled** (the common case) — daily at 04:00 local via the job system. The runner handles locking, catch-up after missed runs, telemetry, and failure surfacing. You never check eligibility or manage `dream.lock` yourself.
- **Trigger phrase** ("dream", "memory check", "daily maintenance") — runs in-session. Acquire `user-data/state/jobs/locks/dream.lock` via `robin job acquire dream` before starting; release with `robin job release dream` when done. If acquire returns non-zero, a scheduled run is in progress — skip cleanly.

## Pre-flight

Read `user-data/state/jobs/failures.md`. If any active FATAL entry is present, skip this Dream run and append a one-line note to `user-data/state/dream-state.md` explaining why it was skipped. INFO/WARN entries get included in your one-line summary at the end of the run.

## Phase 0: Auto-memory migration (auto-run)

Per the **Local Memory** rule, persistent memory lives in `user-data/`. Some hosts (notably Claude Code) write to `~/.claude/projects/<slug>/memory/` regardless.

The `migrate-auto-memory` node-runtime job (`system/jobs/migrate-auto-memory.md`) drains these directories every hour. By the time Dream runs, anything that needs migrating is already in `user-data/memory/inbox.md` with a `(migrated from <host> auto-memory: <file>)` provenance suffix. Phase 2 routes those entries like any other inbox content.

You don't need to invoke the migration script. If `user-data/state/jobs/migrate-auto-memory.json` shows the job hasn't run recently or its status is `error`, mention it in your one-line summary.

## Phase 1: Scan

Read these files:
- `user-data/state/dream-state.md` (for `last_dream_at` timestamp)
- `user-data/memory/journal.md` — entries dated after `last_dream_at`
- `user-data/memory/inbox.md` — all unprocessed entries
- `user-data/memory/tasks.md` — completed or stale items
- `user-data/memory/self-improvement.md` — all sections (corrections, patterns, session handoff, calibration)
- `user-data/memory/decisions.md` — decisions older than 30 days with no recorded outcome
- `user-data/memory/hot.md` — recent session context (helps with routing accuracy)
- `user-data/memory/log.md` — recent operations (know what was ingested/linted recently)

## Phase 2: Memory management

1. **Inbox routing** — for each entry in `user-data/memory/inbox.md`:
   - If the entry has a tag (e.g., `[fact]`, `[preference]`), use it as a first-pass routing signal. Verify against `system/capture-rules.md` routing table — tags are hints, not binding.
   - `[watch:<id>]` tagged entries: append the full line to `user-data/memory/watches/log.md` (append-only, chronological). Delete from inbox. Do NOT route to the individual watch's `<id>.md` file (that's user-curated). If `watches/log.md` is missing, create it from `system/skeleton/memory/watches/log.md`.
   - `[?]` tagged entries: treat as unclassified, classify from content.
   - `[update]` tagged entries: use `(supersedes: <hint>)` if present to locate the original entry. Update the original, then remove the inbox item.
   - Untagged entries: classify per `system/capture-rules.md` routing table.
   - Consult `user-data/memory/INDEX.md` to pick the destination topic file. Insert under the matching `## ` subsection if one exists.
   - **Dream is the only writer that creates new topic files for inbox-routed content.** If no topic file fits, create one with `description:` and `type:` frontmatter inferred from the entry (see type vocabulary in `system/capture-rules.md`); the next index regen picks it up.
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

11. **Calibration update** — update effectiveness scores where outcomes can be inferred from recent sessions (user follow-up, contradictory actions, or 30+ days of silence → unknown). Disagreement/sycophancy check. Prediction accuracy is owned by `outcome-check` (when enabled) — Dream does not recompute it. If `predictions.md` has resolved entries newer than the last `outcome-check` run, include "N resolved predictions awaiting rollup" in the summary.

12. **Session handoff cleanup** — entries in `## Session Handoff` older than 14 days -> archive to `user-data/memory/journal.md` or delete if resolved.

## Phase 4: Memory tree maintenance

Runs after all other phases. Maintains the memory tree structure.

13. **Threshold splitting** — walk the memory tree. For each topic file under `profile/`, `knowledge/`, or `events/`, run `planSplit` from `system/scripts/lib/memory-index.js` with the threshold from `user-data/robin.config.json` (`memory.split_threshold_lines`, default 200). For any file with a non-null plan: write the children to `<parent-dir>/<parent-stem>/<slug>.md`, delete the parent file, then run a memory-tree-wide search-and-replace updating inbound markdown links from the old path to each child. **Exempt files** (never split): `decisions.md`, `journal.md`, `log.md` (append-only logs read by date range), and top-level `knowledge.md` / `profile.md` if they still exist as monoliths (run `npm run split-monoliths` for those).

14. **Empty-file cleanup** — any topic file that is empty (frontmatter only or no content) is deleted. Any topic folder that ends up empty is removed.

15. **Index regeneration** — run `node system/scripts/regenerate-memory-index.js` to rebuild `user-data/memory/INDEX.md` from per-file frontmatter. Idempotent — exits clean if nothing changed.

16. **Hot cache trim** — if `user-data/memory/hot.md` has more than 3 session entries (sections starting with `## Session —`), keep only the most recent 3 and remove older entries.

17. **LINKS.md maintenance** — if structural changes occurred in this Dream cycle (files were split, deleted, or moved in steps 13-14), run `node system/scripts/regenerate-links.js` to rebuild `user-data/memory/LINKS.md` from the current link graph. Otherwise, trust incremental appends and skip. Deduplicate any duplicate edges.

18. **Conversation pruning** — scan `user-data/memory/knowledge/conversations/` for pages older than 90 days. Check `user-data/memory/LINKS.md` for inbound links. Conversations with zero inbound links after 90 days → flag for user review in escalation report. Do not auto-delete.

## Boundary rule

Dream can read and write any topic file under `user-data/memory/` and the flat files (`tasks.md`, `decisions.md`, `journal.md`, `self-improvement.md`, `inbox.md`).

Dream maintains `user-data/memory/INDEX.md` via `regenerate-memory-index.js` (Phase 4 step 15).

Dream maintains `user-data/memory/LINKS.md` via `regenerate-links.js` when structural changes occurred (Phase 4 step 17).

Dream trims `user-data/memory/hot.md` to a rolling window of 3 sessions (Phase 4 step 16).

Lock management is handled by the runner (scheduled invocation) or the `robin job acquire/release dream` wrappers (trigger-phrase invocation). Dream NEVER edits other lock files.

Dream NEVER edits: `AGENTS.md`, `system/jobs/`, `user-data/integrations.md`, `system/startup.md`, `system/capture-rules.md`, `user-data/robin.config.json`.

Dream NEVER runs external commands or makes network requests.

## Output

### Default

One-line summary written to stdout: "Dreamt: pruned N tasks, routed M from inbox, promoted K facts, processed L reflections, reviewed P patterns, split S topic files, trimmed hot cache, regenerated INDEX/LINKS."

### Escalation report

Triggered by: unresolvable contradictions, ambiguous inbox items, time-sensitive routed items, ineffective patterns, preference contradictions, calibration drift, sycophancy signals, or errors. Append to `user-data/state/jobs/failures.md` under the active failures section, OR for in-session invocation, present under a `## Needs your input` heading. Neutral, factual tone.

## Failure modes

- Lock held by another runner → exit 0 cleanly (the runner already records "skipped:locked" telemetry).
- Error mid-phase → exit non-zero with the error line as the last stderr line; the runner categorizes and surfaces.
- If `user-data/state/dream-state.md` is corrupted → recreate baseline, log to runner.log, exit 0.
