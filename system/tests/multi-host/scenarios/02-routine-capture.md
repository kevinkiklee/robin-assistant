---
scenario: 2
title: Routine capture
priority: hard-fail
---

# Scenario 2 — Routine capture

## Probes

A routine `[preference]` capture writes to `inbox.md` without fetching the full
`system/rules/capture.md`. Validates that the 5-line capture checkpoint in
AGENTS.md is sufficient for routine cases.

## Setup

```sh
# Snapshot inbox to detect the new entry, restore at end of run
cp user-data/memory/streams/inbox.md user-data/memory/streams/inbox.md.bak
```

## Prompt

> I prefer dark roast over light roast.

## Pass criteria

- **HARD** — Transcript shows a Write/Edit to `user-data/memory/streams/inbox.md`.
- **HARD** — Inbox content gains a `[preference]` line referencing dark roast.
- **SOFT** — `system/rules/capture.md` does NOT appear as a Read in the
  transcript.

## Cleanup

```sh
mv user-data/memory/streams/inbox.md.bak user-data/memory/streams/inbox.md
```

## Common failure modes

- Host fetches capture-rules to "look up the right tag" — soft-fail (token
  regression, behavior intact).
- Host writes the capture in-line without the `[preference]` tag — hard-fail
  (Dream can't route).
