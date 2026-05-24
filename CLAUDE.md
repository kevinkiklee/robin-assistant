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

## Never spawn or suggest `claude -p`

**Robin's own code must never shell out to the Claude Code CLI (`claude -p`), and never suggest doing so.** No nested Claude Code agent sessions, ever — not in jobs, integrations, surfaces, or as a suggested workaround.

When a job or task needs LLM work, do it in code: gather data with direct function calls, make a single bounded `llm.invoke(role, …)` through the dispatcher (local Ollama by construction), and do write-backs in code. Robin's daemon is local-only; there is no cloud agentic-CLI escape hatch.

Reason: recursion + cost (a Claude Code session spawning another full agentic session), plus the non-determinism and opacity of a nested agent's tool loop. Stated by Kevin 2026-05-23. See `user-data/content/knowledge/no-nested-claude-p.md`.

## Other conventions

See `user-data/content/knowledge/kevin-preferences.md` for plain-URL formatting and proactive-capture rules.
