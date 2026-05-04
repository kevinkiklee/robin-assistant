---
name: hook-enforcement-review
dispatch: inline
model: opus
triggers: []
description: Aggregates pre-protocol-override hook telemetry and surfaces recurring blocks + hook errors. Called from Dream Phase 3.
runtime: agent
enabled: false
---
# Protocol: Hook enforcement review

Reviews the JSONL telemetry written by the pre-protocol-override hook
(`system/scripts/hooks/claude-code.js`). Observation-only — never edits the
hook, trigger lists, or protocol files. Called from Dream Phase 3 step 11.6.

## Input

- `user-data/runtime/state/telemetry/protocol-override-enforcement.log` — append-only JSONL.
- `user-data/runtime/state/dream-state.md` — for `last_dream_at` watermark.

## Steps

Helper for parsing/aggregation: `system/scripts/jobs/lib/hook-enforcement-review.js` exports `loadTelemetryEntries(workspace, sinceISO)`, `aggregate(entries)`, `buildCorrectionsNote(protocol, slot)`, `buildLearningQueueNote(errorClass, count)`, and `buildSummary(agg)`. Steps below describe the protocol behavior; in practice run `node -e "import('./system/scripts/jobs/lib/hook-enforcement-review.js').then(...)"` to drive it.

1. **Parse telemetry since last dream.** Read the log; filter to entries with `ts > last_dream_at`. Skip lines that fail to parse (best-effort).

2. **Aggregate `event: blocked` by protocol.** Count blocks per protocol since last dream.
   - **Threshold ≥2** for any single protocol → append a recurring-miss note to `user-data/memory/self-improvement/corrections.md`. Include: protocol name, fire count, timestamps of each block, plus the line: "Hook is enforcing but model still attempts the wrong file — investigate whether the injection text needs to be louder or whether this signals model drift."
   - Threshold rationale: ≥2 (not ≥1) filters single accidents while still surfacing genuine recurrence; ≥3 was rejected because the hook exists *because* even one miss is signal.

3. **Aggregate `event: hook_error`.** For each entry, append to `user-data/runtime/state/dream-state.md` `## Notable` with the error string (one line: `<ts> hook_error <mode> <error_class>: <message>`).
   - If the same `error_class` repeats **≥3 times** since last dream → append a learning-queue note to `user-data/memory/self-improvement/learning-queue.md`: "Investigate hook error class `<error_class>` (repeated N times)".

4. **Never auto-edit:** the hook source, the trigger lists, or any protocol file. The user reviews on next session start (corrections.md is in startup load) or weekly review.

## Output

One-line summary appended to Dream's stdout: `Hook review: B blocks aggregated for P protocols, E hook_errors notable.`

## Notes

The "hook never fires for N days" heuristic was rejected — protocols have wildly different expected fire frequencies (`quarterly-self-assessment` fires ~4x/year), and there's no calibration data to set per-protocol thresholds in v1. If usage patterns later suggest a useful frequency baseline, add it then.
