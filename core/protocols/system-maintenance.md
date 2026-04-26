# Protocol: System Maintenance

Weekly interactive review. Covers things that need user input — Dream handles the daily automated housekeeping.

## Triggers

"system maintenance", "maintenance pass", "audit the system", "clean up the workspace"

Proactive: first session of each week (Monday) — offer it.

## Steps

### 1. Task health (interactive)

- Read `tasks.md`. Find items with no activity for >30 days. Ask user: keep / drop / defer.

### 2. Decisions follow-up

- Read `decisions.md`. For decisions >30 days old with no recorded outcome, ask user for the outcome. Update the entry.

### 3. Goals check-in

- Read `profile.md` -> `## Goals`. Prompt user for progress on active goals.

### 4. Inbox review

- Read `inbox.md`. Any items Dream couldn't route (ambiguous) — present to user for classification. Goal: empty inbox.

### 5. Pattern effectiveness

- Read `self-improvement.md` -> `## Patterns`. For each pattern, discuss with user: is the counter-action working? Revise or retire patterns that aren't helping.

### 6. Coordination cleanup

- Read `state/sessions.md`. Remove stale entries (>2 hours old).
- Check `state/locks/` for any lock files older than 24 hours. Delete them (stale from crashed sessions).

## Output

Summary report with sections: Tasks, Decisions, Goals, Inbox, Patterns, Open Questions.

## After

Log completion date in `journal.md` so next maintenance knows the baseline.
