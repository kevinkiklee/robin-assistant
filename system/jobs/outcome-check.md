---
name: outcome-check
description: Weekly review of open predictions whose check-by date has passed. Proposes resolution; user confirms in system-maintenance.
runtime: agent
schedule: "0 10 * * 0"
enabled: false
catch_up: false
timeout_minutes: 15
notify_on_failure: true
---
# Protocol: outcome-check

Revisit open predictions in `user-data/memory/self-improvement/predictions.md`. For each whose `check-by` date has passed:

## Phase 1: Scan

Read `predictions.md`. For each entry under `## Open`:
- If `check-by` is in the future → skip.
- If `check-by` is past but within 90 days → proposed resolution required.
- If `check-by` is past and >90 days old with no signal → auto-resolve as `inconclusive`.

## Phase 2: Propose resolution

For each prediction needing resolution, scan recent context for evidence:
- `user-data/memory/streams/journal.md` (recent entries)
- `user-data/memory/streams/inbox.md` (recent items)
- `user-data/memory/streams/decisions.md` (decisions that confirm/refute the prediction)
- The originating session-id mentioned in the prediction

Propose one of: `resolved-accurate` | `resolved-miss` | `inconclusive`. Include a one-line basis for the proposal.

Output a summary block to `user-data/runtime/state/outcome-check-<YYYY-MM-DD>.md` listing each prediction + proposed resolution. The user reviews this in their next system-maintenance run.

## Phase 3: Auto-resolve stale

For predictions >90 days past check-by with no resolution signal in any source, move them to `## Resolved` with `outcome: inconclusive`, `resolved-at: <today>`, `resolution-source: outcome-check (auto, stale)`.

Use atomic markdown writes (`<path>.tmp` + rename).

## Phase 4: Update calibration rollup

Recompute the calibration aggregates in `user-data/memory/self-improvement/calibration.md` from `predictions.md`. Format:

    ## Prediction accuracy (last 90 days)

    - likely: N predictions, X% accurate (M resolved, K inconclusive)
    - inferred: ...
    - guess: ...

(Reuse atomic write.)
