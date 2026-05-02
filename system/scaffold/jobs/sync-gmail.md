---
name: sync-gmail
description: Pull Gmail inbox metadata snapshot (last 30 days) into knowledge.
runtime: node
enabled: false
schedule: "*/15 * * * *"
command: node user-data/ops/scripts/sync-gmail.js
catch_up: true
timeout_minutes: 5
notify_on_failure: true
---

Pulls last-30-days inbox messages — metadata only (sender, subject, snippet,
labels). No bodies in sync output. Writes inbox-snapshot.md and a derived
senders.md (top 50 senders, frequency + unread + last-seen).

Disabled by default. Enable after running:

  node user-data/ops/scripts/auth-google.js
  node user-data/ops/scripts/sync-gmail.js --bootstrap
  node bin/robin.js jobs enable sync-gmail

Requires GOOGLE_OAUTH_REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET in user-data/ops/secrets/.env.
