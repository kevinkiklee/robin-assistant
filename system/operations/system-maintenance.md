---
name: system-maintenance
triggers: ["clean up the workspace", "system maintenance"]
description: Weekly interactive review covering items that need user input; complements Dream's automated housekeeping.
---
# Protocol: System Maintenance

Weekly interactive review. Covers things that need user input — Dream handles the daily automated housekeeping.

## Triggers

"system maintenance", "maintenance pass", "audit the system", "clean up the workspace"

Proactive: first session of each week (Monday) — offer it.

## Steps

### 1. Task health (interactive)

- Read `user-data/memory/tasks.md`. Find items with no activity for >30 days. Ask user: keep / drop / defer.

### 2. Decisions follow-up

- Read `user-data/memory/decisions.md`. For decisions >30 days old with no recorded outcome, ask user for the outcome. Update the entry.

### 3. Goals check-in

- Read `user-data/memory/profile.md` -> `## Goals`. Prompt user for progress on active goals.

### 4. Inbox review

- Read `user-data/memory/inbox.md`. Any items Dream couldn't route (ambiguous) — present to user for classification. Goal: empty inbox.

### 5. Pattern effectiveness

- Read `user-data/memory/self-improvement.md` -> `## Patterns`. For each pattern, discuss with user: is the counter-action working? Revise or retire patterns that aren't helping.

### 6. Coordination cleanup

- Read `user-data/state/sessions.md`. Remove stale entries (>2 hours old).
- Check `user-data/state/locks/` for any lock files older than 24 hours. Delete them (stale from crashed sessions).

### 7. Self-improvement check-in

- Present current `## Communication Style` (base + domain overrides) to the user: "This is how I've been calibrating to you — anything off?"
- Present `## Domain Confidence`: "Here's where I think I'm strong vs. where I'm less sure — does this match your experience?"
- Revise based on feedback.

## Output

Summary report with sections: Tasks, Decisions, Goals, Inbox, Patterns, Communication Style, Domain Confidence, Open Questions.

## After

Log completion date in `user-data/memory/journal.md` so next maintenance knows the baseline.
