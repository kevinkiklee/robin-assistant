Read and follow AGENTS.md for all instructions (it includes the session-startup protocol — do it).
After every response, scan for capturable signals and write to user-data/memory/inbox.md with tags.

Discovery — never claim an integration or data source is unavailable without first checking:
- `user-data/integrations.md` — canonical list of configured integrations
- `user-data/scripts/` — sync/auth/write scripts (e.g., `sync-lunch-money.js`)
- `user-data/jobs/` — scheduled syncs
- `user-data/memory/knowledge/<topic>/` — already-synced data on disk (often answers the question without an API call)

Claude Code specifics:
- The PreToolUse hook in `.claude/settings.json` blocks writes to `~/.claude/projects/.../memory/`. Don't try; the rule is enforced at the tool layer. Use `user-data/memory/inbox.md` (with a `[tag]` line) or the appropriate `user-data/memory/...` file.
- The Stop hook drains any auto-memory that slipped through. You don't need to invoke the migrate script manually.
- Skills, MCPs, and CLAUDE.md auto-discovery remain on. `--bare` is NOT used.
