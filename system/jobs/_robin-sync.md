---
name: _robin-sync
description: Reconciler heartbeat — picks up new/removed jobs and re-installs scheduler entries.
runtime: node
enabled: true
schedule: "15 */6 * * *"
command: node system/scripts/jobs/reconciler.js
catch_up: false
timeout_minutes: 1
notify_on_failure: false
---

Heartbeat that runs every 6 hours. Reads system/jobs/ and user-data/jobs/,
diffs against currently installed scheduler entries, and applies the delta.

Idempotent. Hash-based early-exit when nothing has changed (sub-10ms in the
common case). Also regenerates INDEX.md, upcoming.md, and failures.md and
cleans up orphaned per-job state files.
