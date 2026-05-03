---
name: backup
dispatch: inline
model: opus
description: Daily snapshot of user-data/ to user-data/backup/.
runtime: node
enabled: true
schedule: "0 3 * * *"
command: node system/scripts/cli/backup.js
catch_up: true
timeout_minutes: 5
notify_on_failure: true
---

Snapshots user-data/ into a timestamped folder under user-data/backup/.
