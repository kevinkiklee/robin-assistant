---
name: learning-queue
dispatch: inline
model: opus
triggers: []
description: Daily population/selection/surfacing/closure/retire pass on the Learning Queue. Called from Dream Phase 3.
runtime: agent
enabled: false
---
# Protocol: Learning queue daily maintenance

Owns the full lifecycle of the Learning Queue
(`user-data/memory/self-improvement/learning-queue.md`):

1. **Population** — turn knowledge gaps into queue entries.
2. **Selection** — pick today's question by domain/keyword score.
3. **Surfacing** — write `today.md` so CLAUDE.md startup #4 picks it up.
4. **Closure** — promote `[answer|qid=...]` markers to the right destination file.
5. **Retire** — drop stale (>60d) open questions.

Called from Dream Phase 3 step 10 (`Run system/jobs/learning-queue.md inline`).
Spec: `docs/superpowers/specs/2026-05-03-learning-queue-activation-design.md`.

## Helper

All deterministic logic lives in `system/scripts/lib/learning-queue.js`:
`loadQueue`, `qidFromHeading`, `pickToday`, `writeToday`, `readToday`,
`clearToday`, `markAnswered`, `retireStale`, `routeFromTag`. Drive it via
`node -e "import('./system/scripts/lib/learning-queue.js').then(...)"` for
each operation, or read the file once and operate inline — your call.

## Inputs

- `user-data/memory/self-improvement/learning-queue.md` — the queue.
- `user-data/memory/streams/inbox.md` — for `[?|origin=...]` candidates AND
  `[answer|qid=...|<original-tag>|origin=user]` closure markers.
- `user-data/memory/self-improvement/session-handoff.md` — capture-sweep
  summaries that may name knowledge gaps.
- `user-data/memory/self-improvement/corrections.md` — recent corrections
  that imply "Robin should have known X."
- `user-data/memory/streams/journal.md` — dated reflections containing
  knowledge-gap signals.
- `user-data/runtime/state/dream-state.md` — for `last_dream_at` watermark.

## Steps

### 1. Population

Scan inputs for entries written since `last_dream_at`. Promote worthy
knowledge gaps to new queue entries:

- `[?|origin=...]` lines in inbox.md — not every `[?]` is a learning-queue
  candidate. Use judgment: a queue question is "what does the user think
  about X" or "what's the user's preference on Y," not a one-off factual
  ambiguity.
- session-handoff.md "captured N items" summaries that mention a recurring
  domain gap.
- corrections.md entries that name a domain Robin keeps misjudging.
- journal.md entries containing meta-reflection on what Robin missed.

For each promoted gap:
1. Compose the heading `### YYYY-MM-DD — <Title>` (today's date).
2. Build the qid via `qidFromHeading(heading, existingQids)`.
3. Append a block with `- qid:`, `- domain:` (best-guess slug), `- why:`
   (one short sentence), `- status: open`, `- added: YYYY-MM-DD`.

Write atomically (read full file, append, write tmp + rename). Skip if the
gap is already represented by an open queue entry (loose substring match
on title is enough).

Population is best-effort. If you find no candidates, move on.

### 2. Selection

Build a recent-captures list from the last 24h of:
- inbox.md (each line; tag is the `domain:` for scoring purposes if it
  carries a `domain=` segment, else use a coarse classifier),
- journal.md, decisions.md, tasks.md (each non-empty line; domain
  inferable from headings if any).

Call `pickToday(queue, captures, today)`. The helper returns the highest
scoring open question (+2 per exact domain match, +1 per ≥2-token keyword
overlap, oldest `added:` tiebreaker, qid lexical final tiebreaker), or
null when the queue is empty.

If picked is null → skip surfacing.

### 3. Surfacing

Determine the `original_tag` for the picked question. If you can map the
question's domain to a likely answer kind, use that
(`scheduling`/`ask-vs-act`/`stress-test`/`communication-style`/etc. → `preference`;
`outcome-learning`/`capture-sweep` → `fact`). When unsure, default to `fact`.

Call `writeToday(workspaceRoot, { qid, question, why, domain, original_tag }, generatedAt)`.
The helper renders the markdown shape per spec.

Append to `user-data/runtime/state/telemetry/learning-queue.log`:
```
{"ts":"<iso>","event":"surfaced","qid":"<qid>","domain":"<domain>","score":<n>}
```

### 4. Closure

Scan inbox.md since `last_dream_at` for lines matching:
```
[answer|qid=<qid>|<original-tag>|origin=user] <answer text>
```

For each match:
1. Look up `qid` in the queue (`loadQueue`).
2. If not found → append `unknown_qid` event to telemetry log; skip.
3. If found and `status: open`:
   - Resolve route via `routeFromTag(<original-tag>)`. If null
     (`fact`/`update`), pick the destination yourself based on the answer
     content (profile/* or knowledge/* topic file).
   - Call `markAnswered(workspaceRoot, qid, { answer, route, date })`.
   - Append the answer to the destination file under an appropriate
     subsection (use INDEX.md as routing aid).
   - If a `today.md` exists and its `qid` matches → call `clearToday`.
   - Remove the answer line from inbox.md (atomic rewrite).
   - Append `answered` event to telemetry log.
4. If found and not `status: open` (manual edit) → leave alone, log skip.

### 5. Retire

Call `retireStale(workspaceRoot, 60, today)`. Append one `retired` event
per dropped qid to telemetry log.

## Stale today.md cleanup

If `today.md` exists with mtime >48h, this Dream skipped a day or
selection failed. Delete it via `clearToday`; the next Dream rewrites.

## Output

One-line summary appended to Dream's stdout:
`Learning queue: populated P, surfaced <qid|none>, closed C, retired R.`

## Failure modes

- Helper throws → log to dream-state.md `## Notable`, surface in summary,
  continue to next sub-step. Do not abort Dream.
- Telemetry log write fails → continue silently (best-effort).
