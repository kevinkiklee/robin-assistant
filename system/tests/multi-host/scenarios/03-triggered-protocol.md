---
scenario: 3
title: Triggered protocol
priority: hard-fail
---

# Scenario 3 — Triggered protocol

## Probes

A trigger phrase causes the agent to fetch the corresponding protocol file
from `system/jobs/` (Tier 2) before producing output.

## Setup

None (clean session ok).

## Prompt

> morning briefing

## Pass criteria

- **HARD** — Transcript shows a Read of `system/jobs/morning-briefing.md`.
- **SOFT** — Output is structured as a briefing (sections like "Today's
  schedule", "Top priorities", or whatever the protocol prescribes).

## Common failure modes

- Agent answers from Tier 1 alone, fabricating a "morning briefing" structure
  rather than fetching the protocol — hard fail.
- Agent fetches multiple protocols speculatively — soft fail.
