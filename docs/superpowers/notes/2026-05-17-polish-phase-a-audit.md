# Polish Phase A — Audit Notes

**Date range:** 2026-05-17 → <end>
**Phase A complete:** <date>

## A.1 Silent-failure hunt

### Inventory

(populated by A.1 tasks)

### Decisions

| Site | Classification | Rationale | Commit |
|---|---|---|---|

## A.2 Dead-code + unused-file purge

### Inventory

(populated by A.2 tasks)

### Decisions

| Item | Decision | Rationale | Commit |
|---|---|---|---|

## A.3 Test gaps + slow-test cleanup

### Inventory

(populated by A.3 tasks)

### Decisions

| Module / Test | Decision | Rationale | Commit |
|---|---|---|---|

## A.4 Observability + invariant hardening

### Baseline metrics

See `docs/superpowers/notes/2026-05-17-polish-phase-a-log-baseline.md`

### Log noise decisions

| Pattern | Count | Classification | Action | Commit |
|---|---|---|---|---|

### Invariant coverage decisions

(populated by A.4 tasks; mirror the table from the spec)

### A.4 known issue carried from Task 5

The active-traffic helper at `system/scripts/log-baseline-traffic.js`
invokes a CLI subcommand `robin recall` that does not exist (and uses
JSON-as-arg for `robin remember` which actually accepts positional
content). Result: both 3-min captures in the initial baseline
(`docs/superpowers/notes/2026-05-17-polish-phase-a-log-baseline.md`)
returned zero log lines. The fix lands during A.4 (rewrite the helper
to use real CLI surfaces like `hot`, `jobs run`, and the correct
`remember` signature). Plan tasks affected: Task 30 (re-baseline +
delta check) — this must re-capture against a working helper before
the deltas can be measured.

## Open for cognition-e1 lane

| File | Finding | Suggested fix |
|---|---|---|

## Open for prompt-injection lane

| File | Finding | Suggested fix |
|---|---|---|

## Open for user

| Item | Question | Recommended action |
|---|---|---|

## Won't fix

| Item | Rationale |
|---|---|

## Bridge to Phase B

_Priority enum: `high` (blocker for Phase B) / `med` (do early) / `low` (do later)._

| Phase B target | Type | Provenance | Priority |
|---|---|---|---|
