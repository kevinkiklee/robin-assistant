# Protocol: System Maintenance

Run monthly (first session of the month) or when triggered.

## Triggers

"system maintenance", "maintenance pass", "audit the system", "clean up the workspace"

Proactive: first session of a new month — offer it.

## Steps

### 1. Task health

- Read `tasks.md`. Find items with no activity for >30 days. Ask user: keep / drop / defer.
- Find completed tasks older than 60 days. Remove or archive to `journal.md`.

### 2. Inbox processing

- Read `inbox.md`. For each entry, classify per `capture-rules.md` routing. Move to destination. Goal: empty inbox.

### 3. Correction -> Pattern promotion

- Read `self-improvement.md` -> `## Corrections`. For mistake types appearing 2+ times, add to `## Patterns` with recognition signals and counter-actions.

### 4. Session handoff cleanup

- Read `self-improvement.md` -> `## Session Handoff`. Entries >14 days old -> resolved or archived to `journal.md`.

### 5. Decisions follow-up

- Read `decisions.md`. For decisions >30 days old with no recorded outcome, ask user for the outcome. Update the entry.

### 6. Goals check-in

- Read `profile.md` -> `## Goals`. Prompt user for progress on active goals.

### 7. Profile freshness

- Skim `profile.md` and `knowledge.md`. Flag any information that seems outdated based on recent conversation context.

### 8. Calibration check

- Read `self-improvement.md` -> `## Calibration`. Update prediction accuracy if any verifiable predictions have matured.

### 9. Disagreement budget

- In past month, how often did the assistant push back on the user's stated intent? If zero, scan for moments it should have.

### 10. Coordination cleanup

- Read `state/sessions.md`. Remove stale entries (>2 hours old).
- Check `state/locks/` for any lock files older than 24 hours. Delete them (stale from crashed sessions).

## Output

Summary report with sections: Tasks, Inbox, Patterns, Decisions, Profile, Open Questions.

## After

Log completion date in `journal.md` so next maintenance knows the baseline.
