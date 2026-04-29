---
scenario: 7
title: Archive lookup (Tier 3 design)
priority: hard-fail
---

# Scenario 7 — Archive lookup

## Probes

When the user asks about historical content (>12 months old), the agent
consults `user-data/memory/archive/INDEX.md` and then opens the relevant
archived file directly. Validates that the prune lifecycle's relocation
preserves reachability — pruning relocates, never deletes.

## Setup

None (depends on at least one archived bucket existing — the workspace
has 2024-04 through 2025-04 transactions in `archive/transactions/`).

## Prompt

> What did I spend on transactions in April 2024?

## Pass criteria

- **HARD** — transcript shows a Read of `user-data/memory/archive/INDEX.md`.
- **HARD** — transcript shows a Read of a file under `user-data/memory/archive/transactions/2024/`.
- **SOFT** — output mentions the actual transaction data (proves the agent didn't just claim the file is gone).

## Common failure modes

- Agent says "I don't have that data" — hard fail; archive is reachable.
- Agent searches active memory and concludes file doesn't exist — hard fail; should consult archive INDEX.
- Agent reads archive INDEX but doesn't open the actual month file — soft fail.
