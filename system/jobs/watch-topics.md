---
name: watch-topics
description: Hourly check of active watches. Fetches new info via WebSearch, dedupes against per-watch fingerprints, redacts, writes deltas to inbox with [watch:<id>] tag. Default disabled.
runtime: agent
schedule: "0 * * * *"
enabled: false
catch_up: false
timeout_minutes: 15
notify_on_failure: true
---
# Protocol: watch-topics

Hourly pass over active watches. Fetches new info, dedupes, writes deltas.

## Context profile

Minimal context. Skip Tier 1 personalization reads; load AGENTS.md hard rules + this protocol + per-watch markdown files only. Saves ~3,000 tokens × 5 watches per tick.

## Phase 1: Pick eligible watches

Read `user-data/memory/watches/*.md`. For each watch:
- Skip if `enabled: false`.
- Skip if `last_run_at` is within the watch's cadence (e.g., daily watch run < 24h ago).

Sort by `last_run_at` ascending (least-recent first). Take top 5 (cap per tick).

## Phase 2: Per-watch fetch

For each eligible watch:

1. Read `user-data/ops/state/watches/<id>.json` for the fingerprint set.
2. Issue WebSearch with the watch's `query`.
3. For each result hit (top 5–10), build a fingerprint: `sha256(canonical-url + summary-first-200-chars)`.
4. Drop hits whose fingerprint is in the set.
5. For new hits, redact via `applyRedaction()` from `system/scripts/sync/lib/redact.js`.
6. If a hit is fully redacted (nothing left), skip it.

## Phase 3: Write outputs

For each watch with new hits:

1. Append `[watch:<id>] <topic> — <hit-title> (<canonical-url>): <one-line summary>` to `user-data/memory/streams/inbox.md`.
2. Add the new fingerprints to `state/watches/<id>.json`'s ring buffer (keep last 50, drop oldest).
3. Update `last_run_at` in both the markdown frontmatter and the state JSON.

## Phase 4: Failure tracking

On per-watch failure (network error, summarization error, write error):
- Increment `consecutive_failures` in state JSON.
- If `consecutive_failures >= 3`: set the watch's `enabled: false` and append a row to `user-data/ops/state/jobs/failures.md` with category `watch_disabled` and reason.

On success, reset `consecutive_failures` to 0.

## Phase 5: Surface

Update `state/jobs/INDEX.md` with the count of watches checked + new hits. Brief summary; the user reviews `[watch]` items in their inbox via Dream's normal routing.
