---
name: dream
dispatch: subagent
model: opus
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

Two passes: **memory management** (route, promote, prune facts) and **self-improvement** (corrections → patterns, calibration, handoff cleanup).

## Invocation

Dream runs in two ways. **Detect which mode you're in by checking `$ROBIN_INVOCATION` in your environment** (`node -e 'console.log(process.env.ROBIN_INVOCATION)'` or read it from a Bash call before doing anything else):

- **Scheduled (runner-spawned)** — `$ROBIN_INVOCATION=scheduled-runner`. The job system fires this daily at 04:00 local. The runner already acquired `dream.lock` (its own PID, in `$ROBIN_RUNNER_PID`, is written to the file). **Do NOT read, check, or touch the lock yourself** — the lockfile contains your parent runner's PID, and matching it as a sibling will make you skip cleanly without doing any work. The runner handles locking, catch-up after missed runs, telemetry, and failure surfacing. Proceed straight to Pre-flight.
- **Trigger phrase** ("dream", "memory check", "daily maintenance") — `$ROBIN_INVOCATION` is unset. You're running in-session. Acquire the lock via `node bin/robin.js job acquire dream` before starting; release with `node bin/robin.js job release dream` when done. If acquire returns non-zero, a scheduled run is in progress — skip cleanly.

## Pre-flight

Read `user-data/runtime/state/jobs/failures.md`. If any active FATAL entry is present, skip this Dream run and append a one-line note to `user-data/runtime/state/dream-state.md` explaining why it was skipped. INFO/WARN entries get included in your one-line summary at the end of the run.

Then clear resolved items from `user-data/runtime/state/needs-your-input.md` via `clearSection` (`system/scripts/lib/needs-input.js`): proposals whose proposal-id has a matching `## Closed` entry in `action-trust.md`; probation-watch entries past `probation-until`; pruning candidates the user already deleted. Wrap each clear in try/catch — failure on one section must not abort the cycle.

## Phase 0: Auto-memory migration (auto-run)

The hourly `migrate-auto-memory` job has already drained `~/.claude/projects/<slug>/memory/` into `user-data/memory/streams/inbox.md` with a `(migrated from claude-code auto-memory: <file>)` provenance suffix. Phase 2 routes them like any other inbox entry. If `user-data/runtime/state/jobs/migrate-auto-memory.json` is stale or its status is `error`, mention it in your one-line summary.

## Phase 0.5: Pre-filter inbox (security)

Before Phase 1 reads inbox.md, run the cycle-1a pre-filter to quarantine any captures that originated from synced/ingested/tool content (lines whose tag carries `origin=sync:*`, `origin=ingest:*`, or `origin=tool:*`):

```sh
node system/scripts/capture/dream-pre-filter.js
```

Confirm exit code 0. The script moves quarantined lines to `user-data/memory/quarantine/captures.md` (paraphrased + redacted) and removes them from inbox.md. Phase 1 then reads the cleaned inbox. Lines without any `origin=` field (post-migration) are also quarantined as policy violations.

## Phase X: Pattern TTL maintenance (cycle-2c)

After memory routing and self-improvement passes, run the pattern lifecycle pass. This processes the per-pattern firings recorded by the model in `user-data/runtime/state/pattern-firings.log` and archives stale patterns:

```sh
node -e "import('./system/scripts/memory/lib/pattern-ttl.js').then(m => console.log(m.processPatternTTL(process.cwd())))"
```

The pass:
- Reads pattern-firings.log (one TSV line per fire: `<timestamp>\t<pattern-name>`).
- Updates each pattern's `last_fired` and `fired_count` frontmatter fields in `user-data/memory/self-improvement/patterns.md`.
- Truncates the firings log on success.
- Moves any pattern whose `last_fired` exceeds its `ttl_days` (default 180) into `user-data/memory/self-improvement/patterns-archive.md`.

Append a summary line to journal: `Dream: archived N patterns, updated M last_fired, fired_count incremented by total K firings.`

**Pattern firing convention (model-instruction)**: when applying a learned pattern (recognizing its signal, executing its counter-action), append one line to `pattern-firings.log` via Bash:

```sh
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t<pattern-name>" >> user-data/runtime/state/pattern-firings.log
```

This idiom is a single Bash call, not blocked by cycle-2a's sensitive-pattern hook. Skipping the append is not a security violation but causes the pattern to drift toward TTL archive.

## Phase 1: Scan

Read these files:
- `user-data/runtime/state/dream-state.md` (for `last_dream_at` timestamp)
- `user-data/memory/streams/journal.md` — entries dated after `last_dream_at`
- `user-data/memory/streams/inbox.md` — all unprocessed entries
- `user-data/memory/tasks.md` — completed or stale items
- `user-data/memory/self-improvement/` — corrections.md, predictions.md, action-trust.md, learning-queue.md, session-handoff.md, communication-style.md, domain-confidence.md, calibration.md, preferences.md (each maintained in its own file)
- `user-data/runtime/config/policies.md` — explicit per-action-class policy (read for cross-reference with action-trust outcomes)
- `user-data/memory/streams/decisions.md` — decisions older than 30 days with no recorded outcome
- `user-data/memory/hot.md` — recent session context (helps with routing accuracy)
- `user-data/memory/streams/log.md` — recent operations (know what was ingested/linted recently)

## Phase 2: Memory management

1. **Inbox routing** — for each entry in `user-data/memory/streams/inbox.md`:
   - If the entry has a tag (e.g., `[fact]`, `[preference]`), use it as a first-pass routing signal. Verify against `system/rules/capture.md` routing table — tags are hints, not binding.
   - `[watch:<id>]` tagged entries: append to `watches/log.md` (append-only). Delete from inbox.
   - `[?]` tagged entries: treat as unclassified, classify from content.
   - `[update]` tagged entries: use `(supersedes: <hint>)` if present to locate the original entry. Update the original, then remove the inbox item.
   - Untagged entries: classify per `system/rules/capture.md` routing table.
   - Consult `user-data/memory/INDEX.md` to pick the destination topic file. Insert under the matching `## ` subsection if one exists.
   - **Dream is the only writer that creates new topic files for inbox-routed content.** If no topic file fits, create one with `description:` and `type:` frontmatter inferred from the entry (see type vocabulary in `system/rules/capture.md`); the next index regen picks it up.
   - **Entity aliases must cover both canonical names and colloquial/activity terms** — auto-recall hits on aliases only. For each `type: entity` file, list every plausible term the user might use (e.g., a gardening outdoor space gets `garden`/`container garden`; a streaming home office gets `studio`).
   - Confident match -> move to destination file, delete from inbox
   - Ambiguous -> leave in inbox, ESCALATE
   - Time-sensitive (deadline <=14d) -> route AND ESCALATE
   - After writing the topic file, invoke `node bin/robin.js link <memRelPath>` (where `memRelPath` is the path relative to `user-data/memory/`, e.g., `profile/identity.md`). Linker output is a one-line confirmation. If it errors, log to dream output and continue — never block routing on a linker failure.

2. **Fact promotion** — durable facts in `user-data/memory/streams/journal.md` entries (e.g., "got a new doctor: Dr. Smith") -> promote to the matching topic file under `user-data/memory/profile/` or `user-data/memory/knowledge/`.

3. **Task pruning** — completed tasks older than 60 days -> remove. Stale tasks (no activity >30 days) -> flag for user review at next interaction.

4. **Profile and knowledge freshness** — skim topic files under `user-data/memory/profile/` and `user-data/memory/knowledge/` for information that contradicts recent journal entries or conversation context. Flag stale facts for user review.

## Phase 3: Self-improvement

All steps run every dream. Steps with nothing to do are no-ops. Priority order determines what's complete if Dream is interrupted.

5. **Correction promotion** — if a mistake type appears 2+ times in `## Corrections`, promote to `## Patterns` with recognition signals and counter-action. Remove the original correction entries.

6. **Pattern review** — for each existing pattern in `## Patterns`, check recent corrections and journal entries: is the counter-action working? If the same mistake keeps recurring despite the pattern, ESCALATE so the user knows the current counter-action isn't effective.

7. **Session-handoff scan** — scan `## Session Handoff` capture-sweep summaries; feed domains touched into `## Domain Confidence`. (Knowledge-gap extraction is now part of step 10.)

8. **Preference promotion** — scan `## Preferences` for dimensions with 3+ consistent signals. Promote to `## Communication Style` (base style or domain override as appropriate). Check for contradictions between recent signals and established preferences — update or narrow stale preferences. Append unresolvable contradictions to `needs-your-input.md` under `Preference contradictions` via `appendSection`.

9. **Domain confidence update** — review session-handoff summaries, effectiveness scores, and corrections since last dream. Adjust confidence levels. Decay any domain not touched in 90+ days by one level (high→medium; medium stays).

10. **Learning queue maintenance** — run `system/jobs/learning-queue.md` inline. Owns population, surfacing to `today.md`, closure of `[answer|qid=...]` markers, and 60-day retire.

11. **Calibration update** — update effectiveness scores where outcomes can be inferred from recent sessions (user follow-up, contradictory actions, or 30+ days of silence → unknown). Disagreement/sycophancy check. Prediction accuracy is owned by `outcome-check` (when enabled) — Dream does not recompute it. If `predictions.md` has resolved entries newer than the last `outcome-check` run, include "N resolved predictions awaiting rollup" in the summary.

11.5. **Recall telemetry review.** Read entries from `user-data/runtime/state/recall.log` since `last_dream_at`. Append findings to `needs-your-input.md` under `Recall telemetry` via `appendSection`:
   - Auto-recall avg injection bytes; flag if trend is rising >2× compared to prior period.
   - Frequently-matched entities that route to nothing → suggest creating a topic file.
   - Aliases skipped due to missing disambiguator → list for backfill.

11.6. **Hook enforcement review.** Run `system/jobs/hook-enforcement-review.md` inline (≤40 lines).

12. **Session handoff cleanup** — entries in `## Session Handoff` older than 14 days -> archive to `user-data/memory/streams/journal.md` or delete if resolved.

12.5. **Action-trust calibration** — run `system/jobs/action-trust-calibration.md` inline. Owns capture-pipeline check, per-class tally, demotion-on-correction, promotion proposals (24h auto-finalize via `needs-your-input.md`), probation maintenance, and 90-day decay.

## Phase 4: Memory tree maintenance

Runs after all other phases. Maintains the memory tree structure.

13. **Threshold splitting** — walk the memory tree. For each topic file under `profile/`, `knowledge/`, or `events/`, run `planSplit` from `system/scripts/memory/lib/memory-index.js` with the threshold from `user-data/runtime/config/robin.config.json` (`memory.split_threshold_lines`, default 200). For any file with a non-null plan: write the children to `<parent-dir>/<parent-stem>/<slug>.md`, delete the parent file, then run a memory-tree-wide search-and-replace updating inbound markdown links from the old path to each child. **Exempt files** (never split): `decisions.md`, `journal.md`, `log.md` (append-only logs read by date range).

14. **Empty-file cleanup** — any topic file that is empty (frontmatter only or no content) is deleted. Any topic folder that ends up empty is removed.

15. **Index regeneration** — run `node system/scripts/memory/regenerate-index.js` to rebuild `user-data/memory/INDEX.md` from per-file frontmatter. Idempotent — exits clean if nothing changed.

16. **Hot cache trim** — if `user-data/memory/hot.md` has more than 3 session entries (sections starting with `## Session —`), keep only the most recent 3 and remove older entries.

17. **LINKS.md maintenance** — if structural changes occurred in this Dream cycle (files were split, deleted, or moved in steps 13-14), run `node system/scripts/memory/regenerate-links.js` to rebuild `user-data/memory/LINKS.md` from the current link graph. Otherwise, trust incremental appends and skip. Deduplicate any duplicate edges.

17.5. **Compact-summary regeneration** — run the helper from `system/scripts/capture/lib/actions/compact-summary.js` (`regenerateCompactSummary('user-data/runtime/config/policies.md')`) to refresh the `<!-- BEGIN compact-summary -->` block from the AUTO/ASK/NEVER bullet body. Idempotent — content-addressed write, no-op when nothing changed.

17.6. **ENTITIES.md regeneration.** Run `node system/scripts/memory/index-entities.js --regenerate`. Idempotent — exits clean if nothing changed. If it exits 2 ("user-edited"), include the warning in the dream summary and skip; do not retry until the user resolves.

17.7. **Telemetry log rotation.** Cap each file to its limit:
   - `user-data/runtime/state/recall.log` → 5000 lines
   - `user-data/runtime/state/hook-perf.log` → 1000 lines

   Use `node -e "import('./system/scripts/diagnostics/lib/perf-log.js').then(m => m.capPerfLog(process.cwd(), 1000))"` for hook-perf; for recall.log, simple `tail -n 5000 file > file.tmp && mv file.tmp file` (atomic enough at Dream cadence).

17.8. **Protocol-override state cleanup.** Prune files in `user-data/runtime/state/protocol-overrides/` whose basename (session_id) is absent from `runtime/state/sessions.md` AND mtime >24h. Orphans from crashed sessions; hook tolerates stale state itself.

17.9. **Stale today.md cleanup.** If `runtime/state/learning-queue/today.md` mtime >48h (Dream-skip indicator), delete it via `clearToday` from `system/scripts/lib/learning-queue.js`; next Dream rewrites.

18. **Conversation pruning** — scan `user-data/memory/knowledge/conversations/` for pages older than 90 days. Check `user-data/memory/LINKS.md` for inbound links. Conversations with zero inbound links after 90 days → append to `needs-your-input.md` under `Conversation pruning candidates` via `appendSection`. Do not auto-delete.

## Boundary rule

Dream can read and write any topic file under `user-data/memory/` and the flat files (`tasks.md`, `decisions.md`, `journal.md`, `inbox.md`).

Dream maintains `user-data/memory/INDEX.md` via `regenerate-memory-index.js` (Phase 4 step 15).

Dream maintains `user-data/memory/LINKS.md` via `regenerate-links.js` when structural changes occurred (Phase 4 step 17).

Dream maintains the compact-summary block inside `user-data/runtime/config/policies.md` via `regenerateCompactSummary` (Phase 4 step 17.5). The bullet body is user-edited; Dream only rewrites the delimited block.

Dream trims `user-data/memory/hot.md` to a rolling window of 3 sessions (Phase 4 step 16).

Lock management is handled by the runner (scheduled invocation) or the `robin job acquire/release dream` wrappers (trigger-phrase invocation). Dream NEVER edits other lock files.

Dream NEVER edits: `CLAUDE.md`, `system/jobs/`, `user-data/runtime/config/integrations.md`, `system/rules/startup.md`, `system/rules/capture.md`, `user-data/runtime/config/robin.config.json`.

Dream NEVER runs external commands or makes network requests.

## Output

### Default

One-line summary written to stdout: "Dreamt: pruned N tasks, routed M from inbox, promoted K facts, processed L reflections, reviewed P patterns, split S topic files, trimmed hot cache, regenerated INDEX/LINKS."

### needs-your-input.md

Persistent user-facing surface (`user-data/runtime/state/needs-your-input.md`) — write via `appendSection`/`clearSection` from `system/scripts/lib/needs-input.js`. Sections used: `Action-trust promotion proposals`, `Action-trust capture pipeline`, `Recall telemetry`, `Preference contradictions`, `Conversation pruning candidates`. CLAUDE.md startup #4 reads it; the model surfaces items in the first session response. Errors and unresolvable contradictions also append to `user-data/runtime/state/jobs/failures.md`. Neutral, factual tone.

## Failure modes

- Lock held by another runner → exit 0 cleanly (the runner already records "skipped:locked" telemetry).
- Error mid-phase → exit non-zero with the error line as the last stderr line; the runner categorizes and surfaces.
- If `user-data/runtime/state/dream-state.md` is corrupted → recreate baseline, log to runner.log, exit 0.

## Return schema (when dispatched as subagent)

When dispatched via the Agent tool with `subagent_type: general-purpose` per CLAUDE.md, return:

```yaml
routed_count: int           # items moved from inbox to topic files
notable: [string]           # facts/decisions worth surfacing back to parent
errors: [string]            # routing failures or pre-filter rejections
tier1_touched: [string]     # paths under user-data/memory modified in Tier 1
```

## Subagent cutover

Dream writes memory daily — highest-stakes migration. Before retiring inline, run a 7-day parallel-run shadow soak. Procedure + diff helper: `system/scripts/lib/dream-shadow-diff.js` (`diffDreamReturns`, `evaluateSoakWindow`). Gate per spec §5.2 row 4c: 7 consecutive days with no `'major'` severity. Rollback: flip `optimize.subagent_dispatch` in `robin.config.json`.
