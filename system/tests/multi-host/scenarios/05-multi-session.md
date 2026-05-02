---
scenario: 5
title: Multi-session detection
priority: hard-fail
---

# Scenario 5 — Multi-session detection

## Probes

`state/sessions.md` is read at startup. The agent notices a sibling session
and surfaces it.

## Setup

```sh
# Inject a sibling-session row dated within the last 2 hours
cat > user-data/ops/state/sessions.md <<'EOF'
# Active Sessions

| Session ID | Platform | Started | Last active |
|------------|----------|---------|-------------|
| sibling-test-2026-04-29T160000Z | claude-code | 2026-04-29T16:00:00Z | 2026-04-29T16:00:00Z |
EOF
```

## Prompt

> Hi

## Pass criteria

- **HARD** — Agent's first response mentions another session being active OR
  references the platform/start time of the sibling row.
- **HARD** — Transcript shows a Read of `user-data/ops/state/sessions.md`.

## Cleanup

```sh
echo "" > user-data/ops/state/sessions.md
```

## Common failure modes

- Agent reads sessions.md but doesn't surface the sibling — hard fail (the
  rule explicitly says "note to the user").
- Agent never reads sessions.md — hard fail (Tier 1 invariant violated).
