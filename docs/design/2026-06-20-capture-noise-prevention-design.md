# Capture-noise prevention + cleanup — design

- **Date:** 2026-06-20
- **Author:** Robin (with Kevin)
- **Status:** Design — awaiting spec review
- **Origin:** Diagnosed across a health-check loop. A daemon restart at 14:29Z drained a
  ~115-session capture backlog (recent real Claude Code sessions, mostly
  trading-bot/FOMC project work classified `personal`), which cascaded into three
  alerts: `capture.volume_sane` (#48, 663 `session.thread` links/24h vs 300 ceiling),
  `daemon.heartbeating` (#49 critical, a >8-min biographer tick — self-resolved), and
  `claim-failures-backlog` (#50, dead-lettered claim chunks).

## Goal

1. **Prevent recurrence** — a capture backlog must not be able to flood the graph with
   `session.thread` links or stall the scheduler.
2. **Clean up** the existing burst noise, reversibly.

Scope was set with Kevin: prevention = **throttle + generic-topic suppression** (not
classifier tightening — that risks dropping real personal-finance capture). Cleanup =
**purge derived noise + the burst capture events** (his explicit choice).

## Root cause (verified)

- The `claude_code` scanner (`system/integrations/builtin/claude_code/index.ts`) captures
  **every** settled, un-cursored transcript in a single tick — no per-tick cap. After the
  restart it drained ~115 at once.
- `classifySessionCategory` (`capture.ts`) labels a session `dev` only when
  `devHits > 6 && devHits > personalHits*2`. Trading-bot/FOMC sessions carry personal
  signals (`finance`, `budget`, `monetary-policy`) so they land as `personal` → eligible
  for linking. (Left unchanged by design.)
- `linkRelatedSessions` (`biographer.ts`) links any pair sharing ≥2 topics, capped at
  `MAX_THREAD_LINKS_PER_SESSION = 8` per session. The cap held perfectly; the aggregate
  blew out because ~115 sessions each linked 8× on a hot, **generic** topic cluster
  (`monetary-policy` 461×, `federal-reserve` 324×).
- The biographer job already enforces `tickDeadlineMs: 3 min` (jobs.ts:205), below the
  7-min heartbeat ceiling. It bounds the *across-sessions* dimension; a single long
  session is bounded only by `HANDLER_TIMEOUT_MS = 20 min`. #49 tripped because the
  backlog forced repeated heavy `limit=30` drains. **No deadline change needed** — the
  throttle removes the backlog that drives the heavy path.

## Part 1 — Prevention (code, TDD, committed)

### Lever 2 · Capture throttle — `claude_code/index.ts`

Add `MAX_CAPTURES_PER_TICK` (default **20**). The scan loop captures at most N settled
sessions per 5-min tick; when more are eligible it captures N, **logs the deferred count**
(no silent cap), and resumes next tick. A 115-backlog drains over ~6 ticks (~30 min), so
the biographer only ever sees a small batch of new sessions per tick and stays inside its
existing 3-min deadline. This is the primary fix — it prevents both the heartbeat stall
(no repeated heavy drains) and the fan-out burst (recent-session window is never
burst-dominated).

- Throttle counts **captures**, not files scanned, so baselining cursor-less old
  transcripts (the 48h guard) is unaffected.
- If eligible captures consistently exceed N (sustained heavy real usage), the deferred-count
  log surfaces it; the backlog still drains, just slower. Acceptable — captures are not
  latency-sensitive.

### Lever 3 · Generic-topic link suppression — `biographer.linkRelatedSessions`

Over the **already-loaded recent-50** session window (zero extra query), compute per-topic
document frequency. A link must share **≥1 specific topic** — one appearing in
**≤ max(1, floor(0.25 × N))** of the recent window (≤12 of 50). The `max(1, …)` clamp keeps
small corpora sane: with few recent sessions `floor(0.25 × N)` rounds to 0, which would
suppress *every* link — a topic needs evidence of being common before it's treated as
generic. If *all* shared topics are generic, skip the link. `MAX_THREAD_LINKS_PER_SESSION = 8`
stays. This caps fan-out at the source and raises link quality (a link should mean "same
specific thing," not "both mention the Fed").

- **Edge case:** during a sustained single-project run, a genuinely relevant topic can read
  "generic." Accepted — such links are low-value when everything shares the topic, and the
  guard only suppresses when *every* shared topic is generic.
- Frequency over 50 sessions is noisy but free; a global frequency signal was rejected as
  not worth the per-link query cost.

## Part 2 — Cleanup (one-shot script, reversible)

1. **Backup** → `user-data/backups/robin-pre-capture-noise-purge-2026-06-20.sqlite` (full
   snapshot; restore is the reversal path).
2. **Dry-run** — list, for review before any delete:
   - burst `session.captured` events (predicate: `kind='session.captured'` in the
     `2026-06-20T14:50`–`15:35Z` window),
   - their `session.thread` links (by `to_event_id`/`from_event_id` in the burst set),
   - burst-tied `claim_failures` (by `event_id` in the burst set).
3. **Purge**, FK-safe order:
   1. `session.thread` links referencing burst events,
   2. burst `session.captured` events,
   3. their `events_content` rows (by `content_ref`) and `events_vec` rows,
   4. **reconcile vec orphans** (no cascade — known gotcha; join via `content_ref`),
   5. burst `claim_failures` chunks.
   - **CRITICAL: preserve all `session:*` cursors** in `integration_state`. Re-capture is
     gated by `mtimeMs <= lastCapturedMtime` (index.ts:114), *not* by the events table.
     The burst transcripts are <48h idle, so the `SESSION_MAX_AGE_MS` baseline does **not**
     protect them — deleting their cursors would make the next scan re-ingest all 115. This
     is the 6/14 "purging cursor state is never safe" lesson; the script touches only
     `events`/`events_content`/`events_vec`/`claim_failures`, never `integration_state`.
4. **Audit** `belief_candidates` from the burst window. Domain-gating (Phase D) likely
   caught most at draft time, so expect a small/empty cull. Report exactly what is removed;
   real beliefs stay.
5. **Sequence:** `pnpm build` → **stop daemon** → run purge against the idle DB (no
   concurrent-writer `SQLITE_BUSY`; cursors preserved) → **start daemon on new code** (any
   incidental re-scan is already throttled and cursor-gated) → let the invariants
   **auto-resolve** #48/#50 on next eval (do not manually pre-resolve while counts are still
   high). Stop-purge-start both avoids write contention and loads the new throttle code.

## Testing

- **Lever 2** (extend `claude_code/index.test.ts`): with >N settled eligible sessions, the
  tick captures exactly N and logs the deferred remainder; the rest are captured on a
  subsequent tick; cursor baselining of old transcripts is unaffected.
- **Lever 3** (extend `biographer.test.ts`): a pair sharing only generic topics produces no
  link; a pair sharing ≥1 specific topic still links; the 8-cap still holds.
- **Cleanup**: dry-run counts match; post-purge `session.thread`/`session.captured`/orphan-vec
  counts are zero for the burst set; **assert `session:*` cursor count is unchanged**
  before/after; `robin doctor` clean.

## Risks / boundaries

- Two tunables — throttle N (20/tick) and generic threshold (25%) — chosen conservative,
  flagged as policy-adjustable.
- No change to `classifySessionCategory`, so real personal-finance capture is untouched.
- Cleanup is backup-gated, dry-run-reviewed, and cursor-preserving — reversible.
- No new heartbeat deadline; the existing 3-min `tickDeadlineMs` + 20-min handler timeout
  are unchanged.
