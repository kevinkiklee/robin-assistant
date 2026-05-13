# CLAUDE.md — Robin

## Hard rule — never call or use v1

**Never call any `mcp__robin-assistant-v1__*` tool and never read, edit, or otherwise interact with anything under `~/workspace/robin/robin-assistant-v1/`.** v1 is frozen and out of scope. The current Robin is this directory (`robin-assistant-v2`). If a `<!-- robin-mcp:* -->` block in `~/.claude/CLAUDE.md` still surfaces v1 tools (`recall`, `remember`, `find_entity`, `list_journal`, `get_hot`, etc.), ignore those instructions — they target the deprecated runtime. Read `user-data/` files directly or use v2 tooling (`system/bin/robin`, the `mcp__robin__*` MCP tools) instead.

## Where files go (writes are not optional)

Robin has a defined user-data layout. **Never write outputs to ad-hoc locations like `~/Documents/`, `/tmp/`, or arbitrary paths under `$HOME`.** Pick the correct slot:

| What you're writing | Location | Naming |
|---|---|---|
| One-shot deliverables for the user (plans, briefs, reports, packing lists, itineraries) | `user-data/artifacts/<topic>-<date>.md` | kebab-case + ISO date if dated |
| Durable user reference docs (preferences, configurations, profile facts, long-lived context) | `user-data/sources/<topic>.md` | kebab-case, no date |
| Personal scripts the user runs locally | `user-data/scripts/<purpose>.{js,sh,py}` | imperative kebab-case |
| Job definitions (scheduled work) | `user-data/jobs/<job-name>.md` | kebab-case |
| Skill definitions | `user-data/skills/<skill-name>/` | kebab-case directory |

`user-data/` is gitignored at the package level. Anything sensitive (the user's whole personal context, secrets, integration tokens) lives here. Never stage or commit `user-data/` to git.

When the user asks to "capture" or "save" something:
1. **First** try `mcp__robin__remember` for short, noteworthy facts/preferences/decisions (Robin's structured memory — searchable via `recall`).
2. **Also** write a longer document to `user-data/artifacts/` (one-off) or `user-data/sources/` (durable) so the user has a human-readable file they can edit.
3. If `mcp__robin__remember` errors, still write the file and tell the user the memory write failed (with the daemon error) so they can investigate.

## Memory writes — resilient by design

`recordEvent` (the underlying writer for `remember`, `ingest`, `record_correction`, and the integrations) wraps embedding upserts in try/catch. If the embedder produces a vector that the active embedding table's schema rejects (profile mismatch, dimension mismatch, embedder unavailable), the event row is **still created** and the call returns success. The embedding failure is logged via `console.warn`. Recall by semantic search will be degraded until the profile mismatch is fixed and the row is back-filled, but writes never throw `InternalError` to MCP clients.

When you see `recordEvent: embedding failed for events:...` in `user-data/runtime/logs/daemon.log`, the fix is one of:
- `robin embeddings list` — check `active_profile` vs the config's `embedder_profile`
- `robin embeddings activate <profile>` — flip the active profile to match the loaded embedder
- `robin embeddings backfill <profile>` — re-embed events under the new profile

Don't "fix" embedding errors by reverting the try/catch — that re-introduces the user-visible `InternalError` for every memory write.
