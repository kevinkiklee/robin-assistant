---
name: prune
dispatch: subagent
model: opus
description: Memory pruning — moves >12-month-old content from active tier to archive/. Default disabled.
runtime: agent
schedule: "0 5 1 * *"
triggers: ["prune memory", "memory cleanup", "memory prune"]
enabled: false
catch_up: false
context_mode: minimal
timeout_minutes: 30
notify_on_failure: true
---

# Protocol: prune

You are running headlessly to execute this monthly memory-prune cycle. Move >12-month-old content from active tier to `user-data/memory/archive/`. Relocate only; never delete. `archive/INDEX.md` keeps everything reachable.

Execute the per-cycle steps below. Do NOT load Tier 1 startup files (personality, identity, hot, session-handoff, etc.); do NOT report a session summary; do NOT ask the user for direction. Write the diff report and exit.

## Context profile

Minimal. Load ONLY:
- CLAUDE.md Hard Rules section (Privacy, Verification, Local Memory, Time)
- This protocol
- The candidate files listed by the dry-run scan (read just-in-time per step)

## Active vs archive cutoffs

All cutoffs are 12 months from the current date.

| Source | Active | Archived to |
|---|---|---|
| `knowledge/finance/lunch-money/transactions/<month>.md` | last 12 months | `archive/transactions/<year>/` |
| `knowledge/conversations/<file>.md` | last 12 months | `archive/conversations/<year>/` |
| `decisions.md` | current calendar year | `archive/decisions-<year>.md` |
| `journal.md` | current calendar year | `archive/journal-<year>.md` |
| `self-improvement/calibration.md` | last 100 entries | `archive/calibration-<period>.md` |
| `inbox.md` | unrouted only (Dream removes routed) | (n/a) |
| `sources/` | all (immutable) | (never pruned) |

## Multi-session safety

Skip if `state/sessions.md` has any rows with last-active within 2h. Log
INFO + retry next cycle.

## Per-cycle steps

1. **Skip check** — bail with INFO if sibling sessions are active.
2. **Dry-run scan** — enumerate prune candidates; counts and bytes saved.
   Write to `state/jobs/prune-preview.md`.
3. **Pre-prune backup** — full snapshot of `user-data/memory/` to
   `user-data/backup/<timestamp>-pre-prune/`. Cap retention at 3 most recent
   pre-prune backups (system-maintenance handles cleanup).
4. **Atomic moves** — `renameSync` for each file (under file lock). Never
   delete + recreate.
5. **Year-boundary split** — if this is the first prune of a new calendar
   year AND `archive/.year-split-enabled` exists (created by migration
   0011): split `decisions.md` and `journal.md` into per-year archives,
   leave the current-year files live.
6. **Sub-index regen** — call `regenerate-memory-index.js` for each touched
   sub-index (lunch-money, conversations) plus the main INDEX.
7. **Diff report** — write to `state/jobs/prune-<timestamp>.md`.

## Yearly synthesis (deliberately not built into prune)

Yearly summaries (totals, anomalies, top counterparties) are produced
**on demand** when the user asks, OR incrementally by `monthly-financial.md`.
Prune only archives — keeps the per-cycle budget bounded and avoids surprise
synthesis work.

## Reachability invariant

Every file under `archive/` must be listed in `archive/INDEX.md` (one row
per archived bucket — keeps INDEX compact). The lint-memory check verifies
this. If the agent needs an archived month, it opens it directly by path.

## Rollback

Restore from the pre-prune backup:

```sh
cp -r user-data/backup/<timestamp>-pre-prune/. user-data/memory/
```

## Trade-off

Yearly rollup keeps the active tier small. Original month files survive in
archive — never lost. Recent-quarter queries operate on active data; deep-
history queries open archived files individually.

---

## Developer notes (NOT part of the runtime protocol — for human operators only)

### Default state

`enabled: false` in this upstream definition. Opt in by adding a user-data override at `user-data/runtime/jobs/prune.md` with `enabled: true`.

### First-time opt-in flow

1. **Dry-run.** `robin run prune --dry-run` writes a preview to `user-data/runtime/state/jobs/prune-preview.md`. Nothing changes on disk.
2. **Review** the preview. Confirm cutoffs match expectations.
3. **Confirmed run.** `robin run prune --confirm` writes a pre-prune backup, then relocates content. Diff at `user-data/runtime/state/jobs/prune-<timestamp>.md`.
4. **Verify** `user-data/memory/archive/INDEX.md` reflects the move.
5. **Enable cron** via the user-data override, then `robin run _robin-sync`.

## Return schema (when dispatched as subagent)

```yaml
candidates_examined: int
pruned: [{path, reason, archived_to}]
preserved: [{path, reason}]
archive_index_updated: bool
```
