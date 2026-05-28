# CLAUDE.md — robin-assistant

## Architecture

Robin is a local-first personal AI assistant. Three layers:

```
system/       ← framework: kernel (daemon + scheduler), brain (memory +
                cognition), integrations runtime, surfaces (CLI, HTTP, MCP)
user-data/    ← per-user instance data (gitignored): memory, secrets,
                extensions, jobs, knowledge files
dist/         ← compiled output (gitignored); `pnpm build` to regenerate
```

Runtime: Node.js 24+, ESM, TypeScript. Database: SQLite (better-sqlite3 +
sqlite-vec). Package manager: pnpm.

## Commands

```bash
pnpm install                # install deps
pnpm build                  # tsc + build extensions → dist/
pnpm test                   # node --test across system/
pnpm lint                   # biome lint
pnpm typecheck              # tsc --noEmit
pnpm exec tsx --test <file> # single test
```

Daemon: `launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon`

## Memory & user-data

`user-data/content/knowledge/` is Robin's memory store. Prefer it over Claude
Code's memory system for cross-session context — Robin IS the memory system.

`user-data/` is for **personal data only** (life, preferences, health, finance,
career, creative work) — not dev artifacts (bugs, branches, packages, configs).
The biographer's `BLOCKED_ENTITY_TYPES` in `system/brain/cognition/biographer.ts`
enforces this; add new engineering entity types there.

## Secrets

Secrets live in `user-data/config/secrets/.env` (gitignored). **Every process
entry point must call `loadEnvFile(userData)` before running integrations** —
daemon, both MCP servers, and standalone scripts. Forgetting this is a silent
failure (integration skips with "not set"). OAuth tokens rotate; use
`robin reauth <integration>` to refresh.

## Agentic execution

Agentic `query()` is allowed **only** through `system/agent/runAgent` — ledger-
accounted, tool-allowlisted, turn/time/budget-capped, worktree-isolated for
writes, OS-level sandboxed (seatbelt/bubblewrap), JSONL-transcribed. Direct
`claude -p` shell-outs are banned. For non-agentic LLM work, use
`llm.invoke(role, …)` through the dispatcher.

## Code conventions

- Match surrounding style. Tests collocated: `foo.ts` → `foo.test.ts` (`node:test` + `assert`).
- Integrations: `system/integrations/builtin/<name>/` (shipped) or
  `user-data/extensions/integrations/<name>/` (per-user, gitignored).
  Each has `integration.yaml` + `index.ts` with `tick()` and optional MCP `actions`.
- `pnpm build` compiles user-data extensions in-place (`.ts` → `.js` alongside).
- Integration ticks run inside 120s `withTimeout`. Cognition jobs and user jobs
  are bounded by per-LLM-call timeouts and SDK `timeoutMs`, not a scheduler cap.

## MCP servers

Two stdio MCP servers (configured in `.mcp.json`):

- `robin mcp core` — memory read/write: list, recall, remember, believe, predict, etc.
- `robin mcp extension` — integration actions, run, update, chrome, finance, gmail, etc.

MCP servers are **separate processes** from the daemon — they don't share
process.env or DB connections. Each must independently call `loadEnvFile()` and
`openDb()`.

## Publish pipeline

`system/lib/publish/` converts markdown → HTML → Vercel Blob, served at
`askrobin.io/@<user>/<slug>` (e.g. `/@iser/<slug>`), with a per-user index at
`askrobin.io/@<user>/`. `orchestrate.ts` writes the page blob and a
`users/<userId>/index.json` manifest (`manifest.ts`); `PUBLISH_USER_ID` sets the
publishing identity. Static assets (CSS, JS) live in
`~/workspace/robin/askrobin.io/apps/web/public/_pub/`. The template
(`template.ts`) wraps body HTML; `rehype-slug` generates heading IDs for the
external TOC script (`toc.js`). Serving: `proxy.ts` rewrites `/@<user>/...` to
the internal `askrobin.io/apps/web/app/u/[user]/[slug]/route.ts` (page) and
`u/[user]/route.ts` (index); CSP `script-src 'self'`.

## Per-user instance

`robin init` for one-time setup. `user-data/` is fully gitignored.

## Gotchas

- `pnpm exec tsx -e` doesn't support top-level await — use a temp `.ts` file with `async function main()`.
- `hygiene_review.entity_id` joins to `entities`/`relations` for context display.
- Published HTML is sanitized (no `<script>` tags in body) — scripts go in the template or as external `/_pub/*.js` files.
- The daily brief is pre-generated at 4:30am; the skeleton renders all sections deterministically, then dream-synthesis merges reasoning. Reordering sections in the skeleton won't retroactively fix today's brief.
