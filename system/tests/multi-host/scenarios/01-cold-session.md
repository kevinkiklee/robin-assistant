---
scenario: 1
title: Cold-session load
priority: hard-fail
---

# Scenario 1 — Cold-session load

## Probes

Tier 1 files are read on session start, in declared order, and no Tier 2 file
is loaded unprompted.

## Setup

```sh
# Restore a known clean session: no sibling sessions, no pending failures
echo "" > user-data/state/sessions.md
mkdir -p user-data/state/jobs
cat > user-data/state/jobs/failures.md <<'EOF'
# Job Failures

## Active failures

(none)

## Resolved
EOF
```

## Prompt

> Hi

## Pass criteria

- **HARD** — Every Tier 1 file declared in `system/scripts/lib/token-budget.json`
  (with `optional_existence:false` OR existing on disk) appears as a Read in
  the transcript.
- **HARD** — Read order matches the declared `tier1_files` order. Cache
  pessimism is a hard fail.
- **SOFT** — No Tier 2 file (`system/manifest.md`, `system/rules/capture.md`,
  `system/jobs/*`) appears as a Read.

## Common failure modes

- Host pre-fetches the manifest as a "context discovery" step.
- Host loads files in alphabetical order rather than the AGENTS.md-declared
  order.
- Host elides startup file reads from the transcript (mark as SOFT NOTE).
