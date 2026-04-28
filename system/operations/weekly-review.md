---
name: weekly-review
triggers: ["weekly review"]
description: End-of-week recap covering accomplishments, missed items, and the upcoming week's priorities.
---
# Protocol: Weekly Review

## Triggers

"weekly review", "let's review the week", "Sunday review"

## Steps

### 1. Last week recap

- Read `user-data/tasks.md` for completed items in the past 7 days.
- Read `user-data/integrations.md` for calendar status.
  - If available: list events that happened this week.
  - If not available: ask "What were the key events this week?"

### 2. Backlog health

- Todos in `user-data/tasks.md` older than 14 days untouched -> flag as stale, ask to keep/drop/defer.
- Overdue items -> re-prioritize.

### 3. Financial check (mini)

- Read `user-data/integrations.md` for email status.
  - If available: pull recent receipts/orders.
  - If not available: skip or ask "Any notable spending this week?"
- Check `user-data/knowledge.md` -> `## Subscriptions` for anything anomalous.

### 4. Goal check-ins

Read `user-data/profile.md` -> `## Goals`. Prompt the user for progress on active goals.

### 5. Look ahead

- Read `user-data/integrations.md` for calendar status.
  - If available: next 7 days of calendar.
  - If not available: ask "What's coming up next week?"
- Prep needed for any meetings/events?

### 6. Decisions waiting

Read `user-data/decisions.md` for entries marked pending input.

### 7. Inbox sweep

Read `user-data/inbox.md`. For each entry, classify per `system/capture-rules.md` routing and move to the right file.

## Output

Section-by-section summary. End with: "Anything to capture or commit to before next week?"
