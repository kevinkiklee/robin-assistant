---
name: meta-recall-narrative
schedule: "0 5 * * 0"
runtime: internal
enabled: false
catch_up: false
timeout_minutes: 5
notify: none
notify_on_failure: true
manually_runnable: true
description: Weekly meta-cognition pass over recall failures (kind='reasoning' memo + rule_candidates).
---

Internal job. Implementation in `cognition/jobs/internal/meta-recall-narrative.js`.

Reads `recall_log` rows from the trailing 7 days where `outcome='corrected'`
(primary) and `ranked_hits[*].used CONTAINS false` (secondary, post-B1).
Clusters retrieved memos by shared `about` edges in-Node; calls one
`tier:'fast'` LLM to name the error patterns and suggest behavior rules.

Writes:
- One `kind='reasoning'` memo per run with `meta.dimension='recall_failures'`,
  `derived_by='meta_cognition'`, scope from config (default `'global'`).
- 0-3 `rule_candidates` rows with `kind='behavior'` and
  `payload.source='meta_cognition'`, ranked by LLM confidence.

Gated by:
- `runtime:`meta_cognition.config`.value.enabled` — three-valued:
  `false` (default; job exits immediately), `'shadow'` (runs clustering +
  telemetry, no LLM, no writes), `true` (full path).
- Min-corrections threshold (default 5/week) — fewer than this and the
  job emits a `skipped_below_threshold` telemetry row and exits.

Schedule: Sunday 05:00 **local** time (the cron parser at
`system/cognition/jobs/cron.js` evaluates `Date#getDay()` and
`Date#getHours()` in local time — not UTC). 05:00 is the trough of Robin's
activity envelope: nightly dream has finished, heartbeat-driven syncs are
at minimum, no human is mid-session.

Telemetry: `meta_cognition_telemetry` (one row per invocation). Rollup
defers to C3.

Privacy: rows whose retrieved memos transitively reach `scope='private'`
memos are dropped before clustering (default
`private_scope_action='drop'`). Set to `'fail'` to abort the run instead.
