# CLAUDE.md — robin-assistant-v3

## Memory & persistence

**All cross-session memory for conversations in this folder goes into Robin's user-data, never into Claude Code's own memory system.**

- Save substantive context to `user-data/content/knowledge/<descriptive-name>.md` with `node_type: memory` frontmatter.
- Do **not** write to `~/.claude/projects/-Users-iser-workspace-robin-robin-assistant-v3/memory/`. That directory is unused by design here — keep it empty.
- At session start, read `user-data/content/knowledge/` for Kevin's preferences, photographer profile, project follow-ups, and any other durable memory. Specifically:
  - `kevin-preferences.md` — three explicit behavioral preferences (no-Claude-memory rule, plain URLs, proactive capture)
  - `kevin-as-photographer.md` — photographer profile if anything photo-related comes up
  - The most recent `project-followups-*.md` for in-flight work

This overrides the auto-memory system documented in `~/CLAUDE.md` *for this folder only*. Robin IS Kevin's memory system; splitting persistence between Robin's user-data and Claude Code's memory tree defeats the purpose.

## Other conventions

See `user-data/content/knowledge/kevin-preferences.md` for plain-URL formatting and proactive-capture rules.
