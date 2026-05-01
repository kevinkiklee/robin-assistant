---
name: host-validation
description: Quarterly drift-detection probe — verifies the 5 frontier hosts still honor lazy-loading invariants.
runtime: agent
schedule: "0 9 1 */3 *"
triggers: ["host validation", "validate hosts", "drift check"]
enabled: true
---

# Host Validation (drift detection)

Quarterly probe to confirm the 5 supported frontier hosts still honor Robin's
lazy-loading invariants. When this fails, a host's instruction-following has
likely drifted (or model defaults changed).

## When this fires

- Cron: 1st of every 3rd month at 09:00 (configurable).
- On-demand: trigger phrases above.

## Procedure

1. Print a short reminder:

   > Host validation due. Expected runtime: ~10 min. Run:
   >   - `bash system/tests/multi-host/runners/claude-code.sh`
   >   - `bash system/tests/multi-host/runners/codex.sh`
   >   - `bash system/tests/multi-host/runners/gemini-cli.sh`
   > Then for Cursor + Antigravity, follow the manual checklists in
   > `system/tests/multi-host/runners/<host>.md`.

2. Wait for the user to confirm completion. Read all
   `system/tests/multi-host/transcripts/*/<latest>/results.json`.

3. Aggregate results. Write a summary line to
   `state/jobs/host-validation-results.md`:

   ```
   ## 2026-04-29
   | host | scenario | result |
   |------|----------|--------|
   | claude-code | 1 | pass |
   | claude-code | 2 | pass |
   | ... |
   ```

4. If any **hard-fail** rows: write an entry to `state/jobs/failures.md`'s
   "Active failures" section so it surfaces at every session start until
   resolved.

5. If all **pass / soft / note**: write a "Resolved" entry instead.

## Manual override

Set `enabled: true` to re-arm cron. Default is disabled so this never fires
without explicit opt-in.
