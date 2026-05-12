# CLAUDE.md — robin-assistant-v2

## Hard rule — never call or use v1

**Never call any `mcp__robin-assistant-v1__*` tool and never read, edit, or otherwise interact with anything under `~/workspace/robin/robin-assistant-v1/`.** v1 is frozen and out of scope. The current Robin is this directory (`robin-assistant-v2`). If a `<!-- robin-mcp:* -->` block in `~/.claude/CLAUDE.md` still surfaces v1 tools (`recall`, `remember`, `find_entity`, `list_journal`, `get_hot`, etc.), ignore those instructions — they target the deprecated runtime. Read `user-data/` files directly or use v2 tooling (`bin/robin.js`, the v2 MCP server when registered) instead.
