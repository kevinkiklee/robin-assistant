---
name: reinforce-recall
schedule: "*/5 * * * *"
runtime: internal
enabled: true
catch_up: false
timeout_minutes: 2
notify: none
notify_on_failure: true
manually_runnable: true
description: Reinforce memos that were recalled without a subsequent correction (5-min delayed evaluation).
---

Internal job. Implementation in `src/jobs/internal/reinforce-recall.js`. Walks `recall_log` rows whose `outcome='pending'` and `ts < now - 5 min`; for each row:

- If a `meta.kind='correction'` event landed in the same session within the 5-min window → mark `outcome='corrected'` (no reinforcement).
- Else if the row recorded no hits → mark `outcome='evaluated_no_signal'`.
- Otherwise for each hit memo → `signal_count += 1` and `decay_anchor = time::now()`; mark `outcome='reinforced'`.

Useful memos sharpen with use; noisy memos that lead to corrections don't.
