# Robin

> Personal AI assistant with tiered memory, async scheduling, and multi-agent collaboration via MCP.

Robin is a long-lived local daemon that captures your Claude Code sessions, ingests data from your accounts (Gmail, Calendar, GitHub, Linear, Chrome, finance, weather, and more), builds an entity/relation knowledge graph in SQLite, and exposes itself as MCP servers that Claude Code — and any other MCP client — can talk to.

After `robin init`, the daemon runs in the background. You don't habitually type `robin` commands; Claude does the day-to-day driving through MCP, and Robin remembers across sessions.

## Quick start

```bash
nvm use 24                                # native better-sqlite3 + sqlite-vec require this
pnpm add -g robin-assistant               # or: npm i -g robin-assistant
robin init --yes                          # one-time non-interactive setup
robin daemon install                      # launchd agent (auto-starts on login, macOS)
robin mcp install                         # register robin in ~/.claude.json (replaces v2 entry)
```

That's it. Open Claude Code anywhere on your system; `mcp__robin__*` tools will be available.

## Requirements

- **Node 24** — pinned via `.nvmrc`. `better-sqlite3` is a native binding; ABI must match.
- **macOS or Linux** — Windows tracked but not launch-blocking. `robin daemon install` (launchd) is macOS-only; on Linux, run the daemon under your supervisor of choice (`systemd --user`, `runit`, etc.).
- **Apple Silicon recommended** for local model inference via Ollama; cloud-only configs work on any platform.
- Optional: [**Ollama**](https://ollama.com) for local models on the M-series reference platform (`brew install ollama`). The default embedding model is `qwen3-embedding:8b` at 4096 dims.

## Architecture

- **Single Node daemon** owns the schedule, memory, brain-slot dispatcher, and integration lifecycle.
- **SQLite + sqlite-vec + FTS5** — tiered memory: events firehose, content with embeddings (4096-dim Matryoshka), entities, relations, predictions, corrections, refusals, journals. Optional **Kuzu** projection for graph-walk queries.
- **Pluggable LLM providers** — Ollama, Claude Code (subprocess), DeepSeek, Groq behind one interface, swappable per role (`interactive` / `agentic` / `reasoning` / `summarize` / `classify` / `embed` / `rerank`).
- **Two MCP servers** —
  - `robin-core` (13 tools): `recall`, `remember`, `find_entity`, `get`, `list`, `predict`, `record_correction`, `audit`, `explain`, `health`, `metrics`, `journal`, `power`.
  - `robin-extension` (13 tools, per-project opt-in): one action-dispatcher per integration (gmail, google_calendar, github, linear, chrome, finance) + `run`, `integration_status`, `ingest`, `related_entities`, `resolve_prediction`, `check_action`, `update`.
- **Capture pipeline** with v2-proven skip rules; zod-validated biographer (the v2 JSON-parse failure class is structurally prevented).
- **Cognition jobs** —
  - `biographer.run` every 15 min — extract entities + relations from captured sessions
  - `embed-backfill.run` every minute — embed pending `events_content` rows (deferred off the ingest hot-path, single-flight against Ollama)
  - `dream.run` daily at 03:00 local — resolve overdue predictions, write daily metrics, generate journal entry
  - `daily-brief` (user extension) — morning briefing rendered by the Claude agent
- **9 built-in integrations** — `gmail`, `google_calendar`, `github`, `linear`, `chrome`, `weather`, `finance_quote`, `claude_code` (session capture), `notify` (macOS notifications). Additional integrations live as user extensions under `user-data/extensions/integrations/`.
- **Health monitor + power auto-pause** — invariants run every 60s; battery threshold auto-pauses on macOS; toggling `policies.yaml` takes effect without a daemon restart.
- **Telemetry** — typed event writer with zod-validated kinds; optional OTLP HTTP exporter for downstream collectors.

See `docs/specs/2026-05-18-robin-v3-design.md` for the full architectural spec, and `docs/STATUS.md` for the current implementation snapshot.

## Day-to-day operations

Robin is designed to be invisible after install. Everything below is rare:

```bash
robin status                     # current power/capture/network state
robin pause / resume             # pause scheduled work
robin incognito --for 1h         # disable session capture for a window
robin offline / online           # toggle outbound network
robin doctor                     # diagnostic + invariant check (--json, --emit-runbook --write)
robin upgrade                    # apply pending schema migrations (with backup)
robin reindex                    # backfill embeddings (--limit, --force, --ids, --batch)
robin db backup | restore | vacuum
robin import <dir>               # ingest NDJSON dumps (see Portability)
robin daemon install | uninstall # launchd agent management (macOS)
robin publish --source <md>      # publish markdown to the web (askrobin.io)
robin published                  # list published pages
```

## Publishing to the web

`robin publish` uploads a markdown file as a sanitized HTML page served from your configured domain (default `askrobin.io`). Local images referenced from the markdown are uploaded to Vercel Blob with content-hash-derived keys (idempotent on re-upload) and rewritten in-place.

```bash
robin publish --source path/to/post.md             # default: derive slug; suffix on collision
robin publish --source path/to/post.md --slug foo  # explicit slug; overwrites if it exists
robin publish --mode delete --slug foo             # remove HTML + tracked assets
robin publish --source path/to/post.md --dry-run   # render + size-check without uploading
```

Required secrets in `user-data/config/secrets/.env`:

- `BLOB_READ_WRITE_TOKEN` — Vercel Blob token with write access
- `PUBLISH_USER_ID` — namespace for blob keys (`users/<id>/pages/<slug>/index.html`)
- `BLOB_PUBLIC_BASE_URL` — public Blob CDN base URL
- `PUBLISH_PUBLIC_URL` (optional, defaults to `https://askrobin.io`) — canonical URL prefix

`trust: untrusted` (or `untrusted-mixed`) frontmatter blocks publication unless `--force-untrusted` is set. Inline `<!-- UNTRUSTED-START -->` / `<!-- UNTRUSTED-END -->` blocks are stripped regardless.

## Extensions: jobs and integrations

In addition to integrations (which read external data into the event store), v3 has a **jobs runtime** for cognitive work that doesn't fit the read-tick model.

A job lives in `user-data/extensions/jobs/<name>/` with:

- `job.yaml` — manifest with `schedule` (cron expression or `manual`) and optional `tz`
- `index.ts` — exports `job: Job` with a `run(ctx)` method

The daemon loads jobs at startup (and on hot-reload when files change), registers cron schedules, and runs `job.<name>.run` on the scheduler. The shipped example is `daily-brief` — spawns the Claude agent with the protocol prompt and captures the rendered brief as a `daily_briefing` event.

Integration extensions follow the same shape under `user-data/extensions/integrations/<name>/` and are loaded the same way. See `user-data/extensions/AUTHORING.md` for the contract.

## Portability

Robin's data has two layers: **content** (the source of truth) and **state** (a derivable cache).

- **Content** lives in flatfiles under `user-data/content/`. Anything Robin will reason over — captured sessions, imported messages, journal entries, integration ticks — has a flatfile origin.
- **State** lives in `user-data/state/db/robin.sqlite` (events firehose, entities, relations, predictions, corrections, embeddings, indexes). Any Robin install can rebuild state from content; the DB is never the system of record.

Migrating between Robin versions is therefore a content move, not a schema map:

1. Export from the old install as NDJSON (one file per kind).
2. Drop the files into `user-data/content/imported-from-<source>/`.
3. `robin import <dir>` writes them into the new install's tables.
4. Scheduled biographer + embed-backfill runs derive entities and embeddings under the new install's model.

`~/workspace/robin/tools/v2-export.mjs` is the throwaway exporter for the v2→v3 jump. v3 only knows how to ingest NDJSON, not where it came from — every future migration follows the same shape.

## Configuration

All user-editable configuration lives in `user-data/config/`:

- `models.yaml` — role → provider mapping (see design doc §6)
- `integrations.yaml` — which integrations are enabled, secret refs, granted permissions
- `policies.yaml` — power/capture/network state, auto-policies (battery threshold, low-power-mode, quiet hours, notification gates)
- `hardware.yaml` — detected hardware profile + runtime defaults (written by `robin init`)
- `profile.yaml` — user identity hints
- `secrets/.env` (mode 0600) — environment-style secret file. Also supports `secrets.age` for committed encrypted form.

The `system/` directory ships **no config files** — only TypeScript code. The boundary is enforced by `tests/architecture/boundary.test.ts`.

## Development

```bash
cd robin-assistant-v3
nvm use                                     # picks Node 24 via .nvmrc
pnpm install
ROBIN_USER_DATA_DIR=./user-data pnpm dev    # daemon in foreground
pnpm test                                   # 335 tests, ~20s
pnpm typecheck && pnpm lint
```

Read these in order before contributing:

1. `docs/specs/2026-05-18-robin-v3-design.md` — architectural baseline (what's locked, why)
2. `docs/STATUS.md` — current implementation snapshot
3. `docs/BACKLOG.md` — deferred work organized for future contributors
4. `CONTRIBUTING.md` — workflow, code style, architectural invariants enforced by CI

`docs/companion-repo-template.md` describes the recommended `robin-personal` private-repo pattern for multi-machine sync.

## Open-source posture

- **License:** MIT
- **Reference platform:** M5 Max 64GB (Apple Silicon, MLX backend for Ollama). Other profiles degrade gracefully into smaller defaults or cloud-only mode.
- **Personal data** lives in `user-data/` (gitignored at the package level). For multi-machine sync, the recommended pattern is a private companion repo (`robin-personal`) that contains the whole `user-data/` tree minus `state/db/` (use `restic` for those — see `docs/companion-repo-template.md`).
- **Security:** report issues via GitHub private security advisories (see `SECURITY.md`).

## License

[MIT](./LICENSE)
