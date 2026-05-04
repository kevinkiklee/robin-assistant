---
title: Learning-queue activation
date: 2026-05-03
status: design
scope: robin-assistant CLI (Dream protocol + small helper library)
---

# Learning-queue activation

## Problem

The learning queue (`user-data/memory/self-improvement/learning-queue.md`) is broken at three layers:

1. **Population.** `system/jobs/dream.md` Step 7 says: "scan `## Session Reflections` written since last dream … extract knowledge gaps and add to `## Learning Queue`." `Session Reflections` doesn't exist anywhere — no file, no header, nothing writes one. Dream has no source. The 7 questions in the queue came from migration `0014-seed-learning-queue.js` on 2026-04-30, not from Dream.
2. **Surfacing.** No hook, no trigger, no Stop-time prompt. The queue is loaded into Tier 1 context at session start (CLAUDE.md startup #4) and that's it. The model is supposed to recognize a "natural moment" and spontaneously ask. It doesn't — 0 questions answered in 4 days.
3. **Closure.** Dream Step 10 says it "scans recent journal entries and session handoffs for organically answered questions — mark them answered." Dream itself hasn't routed anything to learning-queue (last run summary: "Phase 3 self-improvement: nothing to promote"). Dead-letter.

## Goals

- Fix all three layers via Dream daily maintenance.
- Population from real sources (not the missing Session Reflections file).
- Active surfacing via a `today.md` file Dream writes daily; CLAUDE.md startup picks it up.
- Closure via explicit `[answer|qid=...]` capture markers from the in-session model.
- Auto-retire stale questions (existing 60-day rule).

## Non-goals

- Per-question priority field. Selection scoring is the priority signal.
- Multi-question surfacing per day.
- User-initiated `/ask` slash command.
- UserPromptSubmit/Stop hook surfacing (Approach 2/3 escalations from Q1).
- LLM-judged closure (rejected in favor of explicit markers).
- Cross-session question persistence beyond `today.md`. Daily rotation accepts loss of unasked questions.
- Auto-promote answered questions to hard rules. Defer until pattern emerges.

## Architecture

Dream owns the entire lifecycle. Each Dream run executes four phases against the queue:

1. **Population** — Dream agent scans `inbox.md` (entries tagged `[?|origin=...]` — note: not every `[?]` is a learning-queue candidate; Dream judgment decides), `session-handoff.md` (capture sweep summaries with notable gaps), `corrections.md` (recent corrections that imply a knowledge gap "Robin should have known X"), `journal.md` (dated reflections containing knowledge-gap signals). Promotes worthy gaps as new entries with auto-generated qids.
2. **Selection** — score each open question by domain match against the last 24h of captures from `inbox.md`, `journal.md`, `decisions.md`, `tasks.md` (timestamp by file mtime + dated headers; approximation acceptable):
   - `+2` per capture whose `domain:` tag exactly matches the question's domain
   - `+1` per capture whose content keyword-overlaps with the question text (≥2 non-stopword tokens)
   - Pick highest score. Tiebreaker: oldest `added:` date. Final tiebreaker: qid lexical.
   - All-zero scores: fall back to oldest open.
3. **Surfacing** — write picked question to `<workspace>/user-data/runtime/state/learning-queue/today.md` (overwritten daily, atomic).
4. **Closure** — scan `inbox.md` since `last_dream_at` for `[answer|qid=...]` lines:
   - Look up qid in `learning-queue.md`. If found and `status: open`:
     - Mark `status: answered`, append `answered: <date>`, `answer: "<text>"`, `route: <destination-file>`.
     - Append the answer to the destination file (route resolved from `<original-tag>`; mapping below).
     - If qid matches `today.md`'s qid → delete `today.md`.
   - Unknown qid → log to `state/telemetry/learning-queue.log` as `unknown_qid`; skip.
5. **Retire** — questions with `status: open` and `added: >60 days` → flip to `status: dropped` with `dropped_reason: "stale, never answered"`.

The model's in-session role:
- Read `today.md` at session start (CLAUDE.md startup #4 addition; positioned LAST in the read list because it's per-day volatile).
- When a natural moment arises in the session (topic match, conversational lull, end of low-stakes exchange), ask the question.
- When the user gives a substantive response, capture as `[answer|qid=<qid>|<original-tag>|origin=user] <answer>`.
- If the user dismisses or signals "not now," do NOT re-ask the same question this session.

No hooks, no enforcement — pure Dream protocol + capture pattern.

## Components (new)

- **`system/scripts/lib/learning-queue.js`** — deterministic helpers used by the Dream protocol. Exports:
  - `loadQueue(workspaceRoot)` → parsed `[{qid, question, why, domain, status, added, answered?, answer?, route?}]`.
  - `qidFromHeading(heading, existingQids)` → slug from `YYYY-MM-DD — Title`. Format: `<date>-<title-slug>`. Collision handling: if slug already exists in `existingQids`, append a 2-char base36 suffix (e.g., `2026-04-30-best-work-time-of-day-a3`).
  - `pickToday(queue, recentCaptures, today)` → selection rule per architecture.
  - `writeToday(workspaceRoot, item)` / `clearToday(workspaceRoot)` / `readToday(workspaceRoot)` — atomic writes.
  - `markAnswered(workspaceRoot, qid, { answer, route, date })` → in-place file edit, atomic.
  - `retireStale(workspaceRoot, ageDays = 60, today)` → in-place edit; returns count retired.
  - `routeFromTag(tag)` → mapping from `<original-tag>` to destination:
    - `preference` → `user-data/memory/self-improvement/preferences.md`
    - `decision` → `user-data/memory/streams/decisions.md`
    - `correction` → `user-data/memory/self-improvement/corrections.md`
    - `fact` / `update` → Dream agent picks (profile/* or knowledge/*; not deterministic in helper)
    - other → `user-data/memory/streams/inbox.md` (Dream re-routes)
- **`system/scaffold/runtime/state/learning-queue/.gitkeep`** — directory exists at install.
- **`system/migrations/0027-add-qids-to-learning-queue.js`** — one-time migration: scan existing `learning-queue.md`, parse `### YYYY-MM-DD — Title` headings, derive qid via `qidFromHeading`, write back with `- qid: <qid>` line as first list item under each heading. Idempotent: skips entries already containing `- qid:`.

## Components (modified)

- **`system/jobs/dream.md`** — replace existing Steps 7 + 10 (both broken) with a single new step "Learning queue daily maintenance" that runs the five phases above. Remove the dangling `## Session Reflections` reference. Phase 4 housekeeping (already exists for INDEX/LINKS/etc.) gains a stale `today.md` cleanup step (delete if mtime > 48h, indicating a Dream-skip; next Dream rewrites). **Pre-merge gate:** re-measure `dream.md` token count given the rewrite (commit `dc73a6c` recently tightened the per-protocol cap). Fallback if over: split learning-queue maintenance into a separate `system/jobs/learning-queue.md` agent job (scheduled daily); Dream just calls it.
- **`system/rules/self-improvement.md`** — update the `## Learning Queue` section: replace "One question per session max, only at natural moments" with the new mechanism (Dream picks daily, in-session ask, explicit closure with `[answer|qid=...]`). Drop the `## Session Reflections` paragraph entirely (described a file that never existed).
- **`CLAUDE.md`**:
  - Startup #4 — append to the END of the read list (today.md is per-day volatile; LAST is prompt-cache-friendly): `user-data/runtime/state/learning-queue/today.md` (only if exists).
  - Operational rules — add: "When `today.md` is non-empty, find a natural moment in the session to ask the question. Capture the user's substantive response with `[answer|qid=<qid>|<original-tag>|origin=user] <answer>`. If the user dismisses or signals 'not now,' do NOT re-ask the same question this session."
- **`system/scaffold/memory/self-improvement/learning-queue.md`** — update schema example to show `qid:` field per entry.
- **`CHANGELOG.md`**.

## Schemas

### Question entry (in `learning-queue.md`)

```markdown
### 2026-04-30 — Best work time of day
- qid: 2026-04-30-best-work-time-of-day
- domain: scheduling
- why: tailor when to surface focus-heavy items
- status: open                      # open | answered | dropped
- added: 2026-04-30
# When status flips to answered, Dream appends:
- answered: 2026-05-08
- answer: "morning, 9–11am peak"
- route: user-data/memory/self-improvement/preferences.md
# When status flips to dropped:
- dropped: 2026-07-01
- dropped_reason: "stale, never answered"
```

Existing entries: backfilled by migration 0027.

### `today.md` (rendered daily by Dream)

```markdown
---
generated_at: 2026-05-04T05:30:00Z
qid: 2026-04-30-best-work-time-of-day
domain: scheduling
---

# Today's learning question

**Question:** Best work time of day?

**Why this matters:** Tailor when to surface focus-heavy items.

**How to answer:** Look for a natural moment in this session to bring it up
(if you're already discussing scheduling, energy, focus, or daily routines,
that's a great time). When the user gives a substantive answer, capture as:

  [answer|qid=2026-04-30-best-work-time-of-day|preference|origin=user] <answer>

If the user dismisses or signals "not now," do NOT re-ask this session.
```

Empty queue (no open questions) → file is absent. CLAUDE.md startup gracefully skips a missing file.

### Telemetry log

`state/telemetry/learning-queue.log` (JSONL):
```jsonc
{ "ts": "...", "event": "populated", "qid": "...", "source": "inbox.md" }
{ "ts": "...", "event": "surfaced", "qid": "...", "domain": "...", "score": 4 }
{ "ts": "...", "event": "answered", "qid": "...", "route": "preferences.md" }
{ "ts": "...", "event": "retired", "qid": "...", "reason": "stale, 61d unanswered" }
{ "ts": "...", "event": "unknown_qid", "qid": "...", "context": "answer marker referenced unknown qid" }
```

## Error handling

- **Empty queue, no open questions:** skip surfacing; `today.md` not written.
- **Population fails to find candidates:** selection still runs against existing open queue. Population is best-effort, non-blocking.
- **Selection scoring tied across all questions:** tiebreaker oldest `added:`; final tiebreaker qid lexical.
- **`today.md` already exists with previous day's question:** overwrite (daily rotation).
- **`[answer|qid=...]` capture lacks `<original-tag>`:** default `fact`; route to inbox.md for normal Dream re-routing.
- **Migration 0027 idempotency:** skips entries that already have `- qid:`. Safe to re-run.
- **No Dream run for >24h:** `today.md` is stale but still valid. CLAUDE.md startup reads it. When Dream finally runs, it overwrites.
- **Stale `today.md` (>48h):** Dream Phase 4 deletes during housekeeping; next Dream pick rewrites.
- **Manual user edit to `learning-queue.md`** (e.g., user marks answered themselves): closure step only modifies `status: open` entries. Manual `status: answered` is respected.

## Testing

### Unit
- `system/tests/lib/learning-queue.test.js` — parser, qid generation (idempotent slugification, collision handling with hash suffix), selection scoring (tied scores, no recent captures, exact + keyword match), markAnswered (in-place edit), retireStale, routeFromTag mapping.

### Migration
- `system/tests/migrate/migration-0027-add-qids.test.js` — backfill on existing seeded entries; idempotent on re-run; preserves all other content.

### E2E
- `system/tests/e2e/jobs/learning-queue-population.test.js` — Dream run with seeded `inbox.md` containing `[?|origin=user]` items → new queue entries with qids.
- `system/tests/e2e/jobs/learning-queue-selection.test.js` — fixture with 3 open questions + recent captures matching one domain → that question becomes today.md.
- `system/tests/e2e/jobs/learning-queue-closure.test.js` — fixture with today.md + matching `[answer|qid=...]` in inbox → next Dream marks answered, routes to destination, clears today.md.
- `system/tests/e2e/jobs/learning-queue-empty.test.js` — empty queue → no today.md written.
- `system/tests/e2e/jobs/learning-queue-stale-retire.test.js` — question added 61 days ago → flipped to dropped.
- `system/tests/e2e/jobs/learning-queue-stale-today-cleanup.test.js` — today.md mtime >48h → Dream Phase 4 deletes it.

## Pre-merge verification gates

1. **Re-measure `dream.md` token count** after Step 7 + Step 10 rewrite. If over per-protocol cap, split learning-queue maintenance into separate `system/jobs/learning-queue.md` job (scheduled daily); Dream invokes it.
2. **Confirm `today.md` placement at end of CLAUDE.md startup #4 doesn't disrupt cache reuse** by spot-checking `cache_creation_input_tokens` before/after on Kevin's instance.

## Scope

**S/M.** Touches: 1 new helper library (~150 lines), 1 new migration (~50 lines), Dream protocol rewrite (Step 7+10 → unified maintenance step), `self-improvement.md` rules update, CLAUDE.md startup + operational rules note, scaffold updates, ~10 tests. No public-facing API change.
