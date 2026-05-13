---
name: state-inference
schedule: "*/5 * * * *"
runtime: internal
enabled: true
catch_up: false
timeout_minutes: 2
notify: none
notify_on_failure: true
manually_runnable: true
scheduler_driven: true
description: Per-source focus inference (5-min cadence). Reads attention + arcs + recent biographed events; LLM-gated by a signal-hash change detector.
---

Internal job. Implementation in `cognition/jobs/internal/state-inference.js`. Heartbeat-paced ticker is mounted in `runtime/daemon/server.js` alongside `stale-episodes` — this manifest is the operator-facing documentation; the actual cadence is set by the daemon ticker (default 5 min), not by the `schedule` field above.

Per tick, for each active episode source:

1. Read the latest non-superseded `state_inference` memo for the source (`latestForSource`).
2. Read the current attention lens at `cfg.attention_window_min` (default 90 min).
3. Pick the dominant active arc (entity-set overlap).
4. Pick up to 5 recently biographed events whose `mentions` edges touch the attention entity set.
5. Compute a SHA-256 hash of `{entities, arc_id, last_event_id}`. If equal to `prior.meta.signal_hash` and the prior is fresh (`< refresh_after_minutes`), skip the LLM call entirely.
6. Otherwise emit a calibration row to `evidence_ledger` (corroborate/refute) classifying the prior against the current snapshot.
7. Call `host.invokeLLM` (fast tier). LLM returns `{ focus_statement, confidence, evidence_snippet, ambiguous, drop }`.
8. If `drop=false`, write a new `kind='state_inference'` memo and supersede the prior. If any candidate entity/event/arc has `scope='private'`, the new memo inherits `scope='private'`.
9. Append one row to `state_inference_telemetry` per source per tick.

Gated by `runtime:state_inference.config.enabled` (three-valued: `false` | `'shadow'` | `true`).

Surfacing of the `<!-- current focus -->` block in the intuition path is also gated by `enabled === true` (suppression rule 1, `system/cognition/intuition/inject.js`).
