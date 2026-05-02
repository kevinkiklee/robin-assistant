---
scenario: 4
title: Reference fetch
priority: soft-fail
---

# Scenario 4 — Reference fetch

## Probes

Per-folder reference content is fetched on demand when the user asks a
question that requires it.

## Setup

None.

## Prompt

> What rule files live under system/rules/? Summarize each.

## Pass criteria

- **HARD** — Transcript shows a Read of `system/rules/README.md`.
- **SOFT** — Output enumerates the rule files (capture, security,
  self-improvement, startup) using the README's descriptions.

## Common failure modes

- Agent answers from training data or memory — hard fail (the per-folder
  README is the source of truth and may have updated).
- Agent fetches the README plus extras (rules/capture.md, jobs/*) — soft fail.
