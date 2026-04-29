---
scenario: 4
title: Reference fetch
priority: soft-fail
---

# Scenario 4 — Reference fetch

## Probes

Reference content (the manifest) is fetched on demand when the user asks a
question that requires it.

## Setup

None.

## Prompt

> List all the well-known paths in this workspace.

## Pass criteria

- **HARD** — Transcript shows a Read of `system/manifest.md`.
- **SOFT** — Output enumerates paths from manifest.md content (system/, user-data/,
  artifacts/, sources/, backup/).

## Common failure modes

- Agent answers from training data or memory — hard fail (manifest is the
  source of truth and may have updated).
- Agent fetches manifest plus extras (capture-rules.md, jobs/*) — soft fail.
