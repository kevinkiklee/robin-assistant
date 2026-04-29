---
name: sync-calendar
description: Pull Google Calendar events (next/last 90 days) into knowledge.
runtime: node
enabled: false
schedule: "*/30 * * * *"
command: node user-data/scripts/sync-calendar.js
catch_up: true
timeout_minutes: 5
notify_on_failure: true
---

Pulls events from all subscribed Google Calendars in a 90-day window (next +
last). Writes scannable upcoming.md / recent.md tables to
user-data/memory/knowledge/calendar/ and lazy per-event detail files for
events with attendees, descriptions, or meeting URLs.

Disabled by default. Enable after running:

  node user-data/scripts/auth-google.js
  node user-data/scripts/sync-calendar.js --bootstrap
  node bin/robin.js jobs enable sync-calendar

Requires GOOGLE_OAUTH_REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET in user-data/secrets/.env.
