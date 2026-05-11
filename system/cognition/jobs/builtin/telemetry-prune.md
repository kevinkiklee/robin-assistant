---
name: telemetry-prune
schedule: "15 * * * *"
runtime: internal
enabled: true
catch_up: false
timeout_minutes: 2
notify: none
notify_on_failure: true
manually_runnable: true
description: Enforce telemetry retention independently of the rollup stage. Deletes raw intuition_telemetry/recall_log rows past 7d (excluding pending), force-prunes pending recall_log rows past 30d, and deletes telemetry_hourly rows past 90d.
---

Internal job. Implementation in `cognition/jobs/internal/telemetry-prune.js`. Belt-and-suspenders:
even if `telemetry-rollup` is failing or disabled (`runtime:telemetry.config.enabled=false`),
retention still runs at :15 every hour and keeps the hot tables bounded.

Schedule `15 * * * *` = every hour at :15 (offset from telemetry-rollup at :05).
