# Protocol: System Maintenance

Run monthly (first session of the month) or when triggered.

## Triggers
"system maintenance", "maintenance pass", "audit the system", "clean up the workspace"

Proactive: First session of a new month — offer it.

## Steps

### 1. Memory pruning
- Read all `memory/short-term/*.md`. Delete or archive items resolved >30 days ago.
- Skim `memory/long-term/*.md`. Flag any contradictions across files.
- Update `memory/INDEX.md` to match actual files.

### 2. Todo health
- Find todos with no activity (no completion, no edit) for >30 days. For each, ask the user: keep / drop / defer with new due date.
- Find completed `[x]` todos older than 60 days — archive to a `todos/archive-YYYY.md` or delete if not worth preserving.
- Re-prioritize: any high-priority items that have aged out of urgency?

### 3. Mistakes → Patterns review
- Read `self-improvement/mistakes.md`.
- For any error type appearing 2+ times → add to `patterns.md` with recognition signals and counter-action.
- For high-blast-radius single mistakes (finance, health, legal, irreversible) → promote on first occurrence per pattern P3.

### 4. Improvements review
- Read `self-improvement/improvements.md`.
- For "proposed" entries: implement low-risk ones now, propose bigger ones to the user.
- For "implemented" entries: verify the change is still in effect.

### 5. Inbox processing
- Read `inbox/inbox.md`. For each entry:
  - Classify per the "Where Does This Go?" decision tree
  - Move/copy to the right file
  - Delete from inbox once routed
- Empty inbox is the goal.

### 6. Profile / skill freshness
- Compare profile claims against latest data in memory. Flag drift.
- For each skill in `skills/`, check the User Preferences section — has anything new emerged in recent conversations that should be added?

### 7. Index integrity
- For each directory with INDEX.md (memory, todos, profile, skills, protocols, knowledge, decisions, self-improvement):
  - Listed files actually exist?
  - All files in directory are listed (or have a reason not to be)?
  - One-line descriptions still accurate?

### 8. Decisions follow-up
- Read `decisions/`. For each decision >30 days old with status "pending" or "decided" — has the outcome materialized?
- Update outcome section if so. Move to "Resolved" in `decisions/INDEX.md`.

### 9. Goals check-in
- Read `profile/goals.md`. For each active goal, prompt the user for progress. Update check-in entry.

### 10. Memory decay (anti-rot)
- For each file in `memory/long-term/`: if last update >180 days AND no recent references in conversation → flag as archive candidate. Move to `archive/memory-YYYY-MM-DD-<topic>.md` after the user confirms.
- For `memory/short-term/`: anything >30 days old → resolved or archived. No exceptions.

### 11. Predictions verification
- Read `self-improvement/predictions.md`. For each row past its "Verify by" date with no Outcome filled in:
  - Check if outcome can be determined now (Gmail, Calendar, Drive, web)
  - Fill in Outcome and Calibrated? columns

### 12. Skill usage update
- Reconcile `self-improvement/skill-usage.md` with what actually happened in past month
- For skills with 0 invocations in 90 days: add to candidates for retirement

### 13. Session handoff cleanup
- Read `self-improvement/session-handoff.md`. Anything >14 days old → resolved or moved to permanent storage.

### 14. Disagreement budget check
- In past month, how often did I push back on the user's stated intent? (`Rule: Disagree`)
- If zero: scan recent conversations for moments I should have disagreed but didn't.

### 15. Coordination cleanup
- Run `core/coordination/register-session.sh cleanup` to remove stale session entries and stale locks.
- Verify `.state/coordination/sessions/` and `.state/coordination/locks/` aren't accumulating cruft.
- If a lock has been held for >24 hours, inspect it manually — likely indicates a session crashed mid-edit.

## Output

Single summary report:
```
## System Maintenance — YYYY-MM-DD

### Memory
- Pruned: N items
- Conflicts flagged: [list]

### Todos
- Stale items: N (decisions: kept/dropped/deferred)
- Archived: N completed

### Self-improvement
- New patterns: [list]
- Improvements actioned: [list]

### Inbox
- Processed: N items, routed to: [destinations]

### Profile / Skills
- Updates: [list]

### Decisions
- Outcomes recorded: [list]

### Open questions for the user
- [list]
```

## After
- If using git, suggest committing the cleanup.
- Note completion in `memory/short-term/last-system-maintenance.md` with date so the next maintenance knows the baseline.
