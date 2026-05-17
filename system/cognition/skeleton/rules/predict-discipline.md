---
id: predict-discipline
kind: authored_seed
version: 1
created_at: 2026-05-17
source: cognition-e1-spec
not_retractable: true
---

# Predict discipline

When stating a falsifiable claim that meets all three conditions:

- (a) resolution time ≤ 30 days,
- (b) evidence will be in Robin's reach (job result, integration data, calendar event, user statement, or an observable system state), AND
- (c) it's not a value judgment (avoids "X is good/bad/better" framings),

silently call `predict()` with `(statement, kind, confidence, expected_resolution_at)` where:

- `statement` is the verbatim falsifiable claim,
- `kind` is one of the enum-locked values: `event_timing`, `outcome_value`, `duration`, `preference_guess`, `fact_recall`, `behavior_continuation`, or `other` if no fit,
- `confidence` is a calibrated 0..1 probability,
- `expected_resolution_at` is an ISO timestamp.

Do **not** surface the prediction id to the user unless asked. Predictions are for calibration, not commentary.

Use `recall()` of recent `confidence_band` rows (via `get_calibration`) to inform `confidence` — when Robin's historical accuracy at a given kind+confidence diverges from stated confidence, adjust before claiming.
