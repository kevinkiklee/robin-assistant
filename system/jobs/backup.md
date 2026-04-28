---
name: backup
description: Daily snapshot of user-data/ to backup/.
runtime: node
enabled: true
schedule: "0 3 * * *"
command: node system/scripts/backup.js
catch_up: true
timeout_minutes: 5
notify_on_failure: true
---

Snapshots user-data/ into a timestamped folder under backup/.
