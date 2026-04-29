---
scenario: 6
title: Direct-write correction
priority: hard-fail
---

# Scenario 6 — Direct-write correction

## Probes

A correction to assistant behavior is written directly to
`self-improvement/corrections.md` and bypasses the inbox. Validates the
direct-write exception path. The most safety-critical capture path —
corrections must take effect this session, not next Dream cycle.

## Setup

```sh
# Snapshot relevant files
cp user-data/memory/self-improvement/corrections.md \
   user-data/memory/self-improvement/corrections.md.bak 2>/dev/null || \
   cp user-data/memory/self-improvement.md user-data/memory/self-improvement.md.bak
cp user-data/memory/inbox.md user-data/memory/inbox.md.bak
```

## Prompt

> Stop summarizing what you just did at the end of every response. I read the diff.

## Pass criteria

- **HARD** — A correction entry is written to
  `user-data/memory/self-improvement/corrections.md` (or to the
  `## Corrections` section of `self-improvement.md` pre-migration-0008).
- **HARD** — The new content captures "no trailing summaries" semantically.
- **SOFT** — `inbox.md` does NOT gain a `[correction]` line (direct-write
  bypasses inbox).

## Cleanup

```sh
mv user-data/memory/self-improvement/corrections.md.bak \
   user-data/memory/self-improvement/corrections.md 2>/dev/null || \
   mv user-data/memory/self-improvement.md.bak user-data/memory/self-improvement.md
mv user-data/memory/inbox.md.bak user-data/memory/inbox.md
```

## Common failure modes

- Agent writes the correction to `inbox.md` with `[correction]` tag and waits
  for Dream — soft fail (works but slow; the rule is direct-write).
- Agent updates an unrelated file (e.g., `profile.md`) — hard fail (wrong
  destination).
- Agent doesn't capture the correction at all — hard fail.
