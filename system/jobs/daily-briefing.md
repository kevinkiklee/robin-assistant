---
name: daily-briefing
dispatch: inline
model: opus
triggers: ["good morning", "brief me", "daily briefing", "morning briefing"]
description: Daily briefing covering calendar, weather, priorities, and any flagged items needing attention today.
runtime: "agent"
schedule: "0 7 * * *"
enabled: false
catch_up: true
timeout_minutes: 15
notify_on_failure: true
---
# Protocol: Daily Briefing

## Triggers

"daily briefing", "morning briefing", "good morning", "brief me", "what's today", "what do I have today"

## Steps

### 1. Calendar

Read `user-data/runtime/config/integrations.md` for calendar status.
- If available: get today's events from the user's primary calendar.
- If not available: ask "What's on your calendar today? Paste or summarize."

### 2. Email

Read `user-data/runtime/config/integrations.md` for email status.
- If available: search inbox for unread/important threads since yesterday morning.
- If not available: ask "Any important emails I should know about?"

### 3. Tasks

Read `user-data/memory/tasks.md`. Collect:
- Items due today
- Overdue items
- Top high-priority pending items

### 4. Context

Read `user-data/memory/self-improvement/session-handoff.md` for active context from prior sessions.

### 5. Compose briefing

Present in this order:
- **Calendar today** — events with times, chronological
- **Inbox highlights** — count + 2-3 items needing attention (if email available)
- **Due today** — tasks with today's due date
- **Watch-list** — overdue or top high-priority items
- **Suggested focus** — 1-2 priorities for the day

## Format

Bullet-style, scannable. Under 200 words unless the day is unusually packed.

## After briefing

Ask: "Anything to add to the day or capture before you start?"
