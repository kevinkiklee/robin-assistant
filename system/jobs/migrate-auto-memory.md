---
name: migrate-auto-memory
dispatch: inline
model: opus
triggers: []
description: Drains host-managed auto-memory (e.g., Claude Code) into user-data/memory/streams/inbox.md per the Local Memory rule.
runtime: node
enabled: true
schedule: "5 * * * *"
command: node system/scripts/capture/auto-memory.js --apply
catch_up: false
timeout_minutes: 1
notify_on_failure: false
---

Hourly drain of host-managed auto-memory directories. Currently:

- `~/.claude/projects/<workspace-slug>/memory/`

For each entry, translates to a tagged inbox.md line with provenance and
removes the source. Dream's Phase 0 also references this script — running
on its own schedule means we don't depend on Dream firing.

Idempotent. Sub-100ms when the source dirs are empty (the common case).
Notify on failure is disabled because the only realistic failures are
filesystem-permission issues that are user-recoverable.
