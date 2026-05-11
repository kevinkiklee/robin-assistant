---
name: meta-calibration-narrative
schedule: "30 5 * * 0"
runtime: internal
enabled: true
catch_up: false
timeout_minutes: 5
notify: none
notify_on_failure: true
manually_runnable: true
description: Weekly per-domain calibration drift summary as a kind='reasoning' memo; emits a rule_candidate when drift is sustained-large over min_weeks consecutive weeks.
---

Internal job. Implementation in `cognition/jobs/internal/meta-calibration-narrative.js`. Cron parser uses LOCAL time (`getMinutes()` / `getHours()` / `getDay()`), so `30 5 * * 0` is Sunday 05:30 local. Staggered 30 minutes after D2's recall-failures-narrative (05:00 local).

Per spec §6:
- Read past-7d resolved predictions, prior-7d for trend, prior-21d meta-narrative memos for sustained-drift detection.
- Skip a domain when `samples < cfg.meta_narrative_min_samples` (default 5).
- Idempotent: dedup probe on `(meta.dimension='calibration', meta.domain, meta.week_starting)`.
- Drift > 0 → over-confident; drift < 0 → under-confident.
- Conditional `rule_candidates` emission with `kind='behavior'` and `payload.source='meta_cognition_calibration'`.
- Telemetry: one `cadence_telemetry` row per run with `step='meta-cal-narrative'`.
