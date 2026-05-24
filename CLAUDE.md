# CLAUDE.md — robin-assistant

Guidance for Claude Code (and any LLM-powered coding agent) working on this
repository.

## Architecture overview

Robin is a local-first personal AI assistant. The codebase has three layers:

```
system/                 ← framework: kernel (daemon + scheduler), brain (memory +
                          cognition), integrations runtime, surfaces (CLI, HTTP, MCP)
user-data/              ← per-user instance data (gitignored): memory, secrets,
                          extensions, jobs, knowledge files
dist/                   ← compiled output (gitignored); `pnpm build` to regenerate
```

Runtime: Node.js 24+, ES modules, TypeScript (tsx for dev, tsc for build).
Database: SQLite via better-sqlite3 + sqlite-vec for vector search.
Package manager: pnpm.

## Common commands

```bash
pnpm install              # install dependencies
pnpm build                # tsc + build extensions → dist/
pnpm test                 # node --test across system/
pnpm lint                 # biome lint
pnpm typecheck            # tsc --noEmit
```

Run a single test file:
```bash
pnpm exec tsx --test system/path/to/file.test.ts
```

## Memory & persistence

Robin manages its own memory in `user-data/content/knowledge/`. When working
on this repo as a contributor, **prefer Robin's user-data for cross-session
memory over Claude Code's own memory system** — Robin IS the memory system, and
splitting persistence between two stores defeats the purpose.

- Save context to `user-data/content/knowledge/<descriptive-name>.md` with
  `node_type: memory` frontmatter.
- At session start, read `user-data/content/knowledge/` for user preferences
  and project follow-ups.

## Sanctioned agentic execution

Agentic `query()` (the SDK tool-loop) is allowed **only** through
`system/agent/runAgent`. That one primitive is ledger-accounted (one
`agent_usage` row per run), tool-allowlisted (explicit `allowedTools`, no
"all"), turn/time/budget-capped (`maxTurns` + `timeoutMs` + `maxBudgetUsd` +
per-surface daily cap), and worktree-isolated for write work. Every run leaves a
full JSONL transcript on disk, so the loop is auditable, not opaque.

Direct `claude -p` shell-outs, and any path that reaches `query()` without going
through `runAgent`, remain **banned** — no ad-hoc nested sessions in jobs,
integrations, surfaces, or workarounds. For plain (non-agentic) LLM work, use
`llm.invoke(role, …)` through the dispatcher.

## Code conventions

- Match the surrounding code's style — comment density, naming, idiom.
- Integration handlers live in `system/integrations/builtin/<name>/` (shipped
  with the package) or `user-data/extensions/integrations/<name>/` (per-user,
  gitignored).
- Every integration has an `integration.yaml` manifest + `index.ts` with a
  `tick()` function and optional `actions` for MCP.
- Tests are collocated: `foo.ts` → `foo.test.ts`, using `node:test` + `assert`.
- The scheduler runs handlers inside a 120s timeout (`withTimeout`) — a hung
  handler cannot wedge the tick loop.

## MCP servers

Robin exposes two MCP servers (stdio transport):

- `robin mcp core` — read/write memory: list, recall, remember, believe,
  predict, find_entity, journal, health, metrics.
- `robin mcp extension` — integration actions, run, update, chrome, finance,
  gmail, google_calendar, linear, github, spotify, ingest.

Configure via `.mcp.json` (copy `.mcp.json.example` and adjust paths).

## Secrets

Secrets live in `user-data/config/secrets/.env` (gitignored). The daemon loads
them at startup via `loadEnvFile()`. OAuth tokens for Google integrations
rotate; use `robin reauth <integration>` to refresh them.

## Per-user instance

After cloning, run `robin init` for one-time setup (creates `user-data/`,
seeds config, optionally installs the launchd daemon). The `user-data/`
directory is fully gitignored — it contains personal data, secrets, and
instance-specific configuration that must never be committed.
