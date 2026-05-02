---
description: Per-action-class earned-trust calibration. Each class accumulates outcomes; Dream proposes promotion at ≥5 successes / 0 corrections / 30 days; auto-confirms 24h after surfaced unless user objects. 7-day probation on newly-promoted AUTO. First correction demotes AUTO → ASK same turn.
type: topic
---

# Action Trust

Calibration evidence per action class. Source of truth; the compact-summary block in `user-data/policies.md` is the derived view loaded at session start.

Outcome states for `[action]` capture entries:
- `silent` — AUTO action with no objection
- `approved` — ASK action with user yes
- `corrected` — user reversed/objected (same turn or next session)
- `pending` — action taken, awaiting feedback window

## Open

<!-- Active classes appended here. Newest first. Each entry: class name, attempts/successes/corrections counters, last-action date, promotion-eligible-at threshold, next-review date, optional probation-until date. -->

## Closed

<!-- Promotion/demotion records appended here. Newest first. Each entry: class → AUTO|ASK|NEVER, date, evidence summary. -->
