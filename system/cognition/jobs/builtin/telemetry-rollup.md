---
name: telemetry-rollup
schedule: "5 * * * *"
runtime: internal
enabled: true
catch_up: false
timeout_minutes: 2
notify: none
notify_on_failure: true
manually_runnable: true
description: Roll up hot-tier telemetry (intuition_telemetry, recall_log, cadence_telemetry hot steps, meta_cognition_telemetry) into telemetry_hourly. Prunes raw rows past 7d and hourly rows past 90d. Force-prunes stuck pending recall_log rows past 30d.
---

Internal job. Implementation in `cognition/jobs/internal/telemetry-rollup.js`. Reads
`runtime:telemetry.config`; if `enabled=false`, no-ops. Iterates the registered hot-source
SELECTs (per `system/cognition/telemetry/rollup-registry.js`) over `[$cursor, $cutoff)` where
`$cutoff = now - cutoff_safety_seconds`, UPSERTs `telemetry_hourly:{dim_hash}` rows, advances
per-cursor. Then runs Stage 2 retention (7d raw), Stage 2b pending hard ceiling (30d), and
Stage 3 hourly retention (90d). Fail-soft per stage and per cursor.

Schedule `5 * * * *` = every hour at :05 (small offset from heartbeat boundary so it doesn't
contend with reinforce-recall at :00).
