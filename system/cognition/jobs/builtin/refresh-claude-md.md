---
name: refresh-claude-md
schedule: "0 * * * *"
runtime: internal
enabled: true
catch_up: false
timeout_minutes: 2
notify: none
notify_on_failure: true
manually_runnable: true
description: Regenerate <packageRoot>/CLAUDE.local.md and GEMINI.local.md (workspace-local, gitignored) from current persona / jobs / integrations / calibration. Skips writing when the rendered content is byte-equal to the existing file, so the hourly cadence stays cheap. Without this, comm-style synthesis, approved rule_candidates, and integration manifest changes only reach the agent on a manual `robin mcp install`.
---
