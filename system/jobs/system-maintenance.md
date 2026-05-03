---
name: system-maintenance
dispatch: subagent
model: opus
triggers: ["clean up the workspace", "system maintenance"]
description: Weekly interactive review covering items that need user input; complements Dream's automated housekeeping.
runtime: "agent"
enabled: false
timeout_minutes: 30
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

- Read `user-data/memory/streams/decisions.md`. For decisions >30 days old with no recorded outcome, ask user for the outcome. Update the entry.

### 3. Goals check-in

- Read `user-data/memory/profile/goals.md`. Prompt user for progress on active goals.

### 4. Inbox review

- Read `user-data/memory/streams/inbox.md`. Any items Dream couldn't route (ambiguous) — present to user for classification. Goal: empty inbox.

### 5. Pattern effectiveness

- Scan `user-data/memory/self-improvement/` for the appropriate patterns subtopic file (promoted patterns from Dream). For each pattern, discuss with user: is the counter-action working? Revise or retire patterns that aren't helping.

### 6. Coordination cleanup

- Read `user-data/runtime/state/sessions.md`. Remove stale entries (>2 hours old).
- Check `user-data/runtime/state/locks/` for any lock files older than 24 hours. Delete them (stale from crashed sessions).

### 7. Prediction resolutions

- Check `user-data/runtime/state/` for any `outcome-check-<date>.md` summary files produced by recent `outcome-check` runs.
- For each pending summary, walk the user through the proposed resolutions one at a time:
  - Read the prediction and the proposed outcome (`resolved-accurate` / `resolved-miss` / `inconclusive`).
  - Ask the user: "Does this match what happened? [y / change outcome / skip]"
  - On confirmation (or changed outcome), move the entry from `## Open` to `## Resolved` in `predictions.md` with fields: `outcome:`, `resolved-at: <today>`, `resolution-source: system-maintenance`.
  - On skip, leave the entry in `## Open` and note it in the summary report.
- After all summaries are processed, delete the reviewed `outcome-check-<date>.md` files.
- If no summary files exist and `outcome-check` job is enabled, note how many open predictions are past their check-by date (a prompt to run `outcome-check` manually if needed).

### 8. Audit findings review

- Check `user-data/runtime/state/audit/` for any pending `<date>.md` files produced by recent `audit` runs.
- For each audit file, walk the user through findings one at a time:
  - Present the finding: type (`contradiction` or `redundancy`), the two files, the conflicting/duplicate claims, and the suggested action.
  - Ask the user: "How do you want to handle this? [fix now / skip / dismiss]"
  - On **fix now**: apply the edit the user describes (merge, supersede, delete duplicate, add context). Do not auto-decide — confirm the exact change with the user first.
  - On **skip**: leave the finding in the audit file for the next maintenance run.
  - On **dismiss**: mark the finding as reviewed with no action needed.
- After all findings in a file are resolved or skipped, delete the audit `<date>.md` file.
- If no audit files exist and the `audit` job is enabled, note how many days since the last run (check `user-data/runtime/state/jobs/INDEX.md`).

### 9. Self-improvement check-in

- Present current `## Communication Style` (base + domain overrides) to the user: "This is how I've been calibrating to you — anything off?"
- Present `## Domain Confidence`: "Here's where I think I'm strong vs. where I'm less sure — does this match your experience?"
- Revise based on feedback.

## Output

Summary report with sections: Tasks, Decisions, Goals, Inbox, Patterns, Prediction Resolutions, Audit Findings, Communication Style, Domain Confidence, Open Questions.

## After

Log completion date in `user-data/memory/streams/journal.md` so next maintenance knows the baseline.

## Return schema (when dispatched as subagent)

```yaml
checks_run: [string]
issues: [{kind, path, severity, fix_suggested}]
auto_fixed: [{kind, path, what}]
manual_required: [{kind, path, what}]
```
