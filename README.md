# robin-assistant v6 (alpha)

A personal AI memory layer for Claude Code and Gemini CLI, backed by an embedded multi-model database. Robin captures what you talk about, links it into a graph, consolidates it nightly, and serves it back through MCP — so the next session knows what the last one knew.

This is the SurrealDB-first rebuild of Robin. v1 (`robin-assistant@5.x`) remains daily-use Robin until cutover is comfortable; the migrator + safety floor shipped in alpha 8b/9.

## Status

`6.0.0-alpha.12` — Phase 4 envelope + user-data isolation: daily-use safety floor (4a), action policy + comm-style + predictions/calibration (4b), knowledge ops (4c), daemon-internal job runner (4d), conversation capture (4f), the rename pass that gives every long-lived mechanism a named faculty, configurable `<robinHome>` with non-interactive install flags, per-phase hooks-disable, and `robin db browse`. Remaining envelope: 4e (trained reranker + knowledge-promotion classifier) — both data-dependent.

See [`CHANGELOG.md`](CHANGELOG.md) for the per-phase delta and the design docs under [`docs/superpowers/specs/`](docs/superpowers/specs/) for architecture rationale.

## Key features

- **Short-term memory — the biographer agent.** After each agent turn (Stop hook), the biographer reads the new rows in `events`, makes one LLM call per event, and writes structured `entities`, typed edges (`mentions`, `about`, `works_on`, `participates_in`, `co_occurs_with`, `precedes`), and `episode` boundaries. This is the working-memory layer: each raw turn is normalised into who/what was discussed and how it links to prior turns.
- **Long-term memory — the dream agent.** Nightly at 4 AM (`process.env.TZ`), dream runs a 5-step pipeline over events stamped `dreamed_at IS NONE`: promotes durable facts into `knowledge`, mines recurring `patterns`, updates the user `profile`, segments long-running `threads`, and clusters corrections into `rule_candidates`. Events are then stamped `dreamed_at`, so re-running is idempotent.
- **Self-improvement and learning — the reflection loop.** Corrections captured via `record_correction` accumulate in the DB. Reflection (step 3 of the dream pipeline) clusters them (cosine ≥ 0.85, min 3 occurrences, 30-day window) into `rule_candidates`. You approve or reject with `robin rules approve <id>`; approved rules surface in `CLAUDE.md` / `GEMINI.md` on the next session start.
- **Multi-model storage with a graph database.** Robin runs on embedded SurrealDB v3 (`rocksdb://`). One database and one query language (SurrealQL) cover: documents (`events`, `knowledge`, `profile`), a typed graph with foreign-key-enforced edges (`mentions`, `about`, `precedes`, `works_on`, `participates_in`, `co_occurs_with`), HNSW vector indexes (768-dim event embeddings, 384-dim entity/knowledge embeddings), key-value runtime state (`runtime_*`), and time-ordered event streams. Graph traversal, vector kNN, and field filters compose in a single query — no application-level join layer between stores.
- **MCP as the agent interface.** Every agent-facing operation — `recall`, `remember`, `find_entity`, `related_entities`, `list_episodes`, `list_threads`, `list_journal`, `record_correction`, `run_biographer`, `run_dream`, plus per-integration tools (gmail, calendar, github, spotify, …) — is exposed as an MCP tool over SSE. Claude Code, Gemini CLI, and any other MCP-aware host talk to Robin the same way they talk to any other MCP server.

## Faculties at a glance

Robin's behaviour is organised into seven named faculties. Each maps to a specific mechanism and a small set of files. See [`docs/faculties.md`](docs/faculties.md) for the deep dive.

| Faculty | What it does | Lives in |
|---|---|---|
| **intuition** | UserPromptSubmit hook injects relevant memory into the next turn | `src/hooks/handlers/intuition.js`, `src/recall/intuition.js` |
| **biographer** | Per-turn: normalises new events into entities, edges, episodes | `src/capture/biographer.js`, `src/graph/` |
| **heartbeat** | 60s tick: integration syncs, biographer queue, stale-session sweep | `src/daemon/scheduler.js` |
| **discretion** | Refuses inappropriate writes (inbound), commands (bash), and outbound payloads | `src/hooks/handlers/discretion.js`, `src/hooks/inbound-guard.js`, `src/outbound/policy.js` |
| **dream** | Nightly 5-step consolidation into knowledge, patterns, profile, threads, rule candidates | `src/dream/pipeline.js` |
| **reflection** | Step 3 of dream — clusters correction events into rule candidates | `src/dream/step-reflection.js` |
| **introspection** | Daemon-boot integrity check against the install manifest baseline | `src/daemon/introspection.js`, `runtime_introspection_state` |

## How the memory pipeline looks

**Biographer — short-term memory, one LLM call per event:**

```
stop_hook fires after agent turn
        │
        ▼
 new events  ──►  biographer  ──►  1 LLM call per event
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
          entities                      edges                     episodes
       resolve / upsert            mentions, about,            open / extend /
       via 3-stage cascade         works_on, precedes,         close on 30-min
       (exact → embedding          co_occurs_with,             quiet window
        → disambig)                participates_in
```

**Dream — long-term memory, nightly 5-step consolidation:**

```
events WHERE dreamed_at IS NONE
        │
        ▼
┌───────────────── Dream pipeline (nightly, 4 AM) ──────────────────┐
│                                                                    │
│  1. knowledge    →  durable facts                  →  knowledge    │
│  2. patterns     →  recurring shapes               →  patterns     │
│  3. reflection   →  cluster ≥3, cos ≥0.85, 30 day  →  rule_cand.   │
│  4. profile      →  long-running user model        →  profile      │
│  5. threads      →  ongoing arcs                   →  threads      │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
        │
        ▼
UPDATE events SET dreamed_at = time::now()   (re-runs are idempotent)
```

**Reflection — corrections become rules:**

```
record_correction(...)  ──┐
record_correction(...)  ──┤   n correction events with embeddings
record_correction(...)  ──┘
                          │
                          ▼   dream nightly, step 3
              cluster: ≥3 events, cosine ≥ 0.85, within 30 days
                          │
                          ▼
                    rule_candidates
                          │
                          │   robin rules approve <id>
                          ▼
                        rules
                          │
                          ▼
         merged into the <!-- robin --> block of
         ~/.claude/CLAUDE.md on next session start
```

## Quickstart

```sh
git clone git@github.com:kevinkiklee/robin-assistant.git robin-v2
cd robin-v2
npm install
node bin/robin install            # interactive — picks embedder profile, runs migrations, installs hooks, starts daemon
```

Then **restart your Claude Code / Gemini CLI session** so it picks up the new MCP server and hooks. Verify with `robin doctor`.

Full walkthrough including secrets, OAuth, Discord, pre-commit hook, and uninstall: [`docs/install.md`](docs/install.md).

## Daily life

You don't talk to Robin directly — your agent does. After install, just use Claude Code or Gemini CLI normally. Robin:

- Injects relevant memory at the start of every turn (intuition on UserPromptSubmit)
- Refuses dangerous Bash commands (discretion: secrets-read, destructive-rm, `surreal sql` against the local DB, etc.)
- Refuses memory writes that contain credentials or secrets (inbound discretion)
- Captures the turn's content into events, biographs them into entities + edges + episodes, and consolidates nightly into long-term knowledge
- Surfaces rule candidates from your corrections after reflection clusters them

Outbound writes (`github_write`, `spotify_write`, discord replies) pass through `src/outbound/policy.js` (outbound discretion: PII / secrets / verbatim-untrusted-quote guards) and a per-tool sliding-1h rate limiter (default 10/hr).

## Documentation

| Topic | Where |
|---|---|
| Architecture, big-picture diagram, agent-turn walkthrough, DB schema + example queries | [`docs/architecture.md`](docs/architecture.md) |
| Per-faculty deep dive (intuition, biographer, heartbeat, discretion, dream, reflection, introspection) | [`docs/faculties.md`](docs/faculties.md) |
| Full install + integration catalog + OAuth + Discord + pre-commit | [`docs/install.md`](docs/install.md) |
| Common problems and fixes | [`docs/troubleshooting.md`](docs/troubleshooting.md) |
| Adding an MCP tool, integration, hook handler, migration | [`docs/development.md`](docs/development.md) |
| What AI agents should know when they connect | [`AGENTS.md`](AGENTS.md) |
| Per-phase design docs | [`docs/superpowers/specs/`](docs/superpowers/specs/) |

## Command reference

### Daemon

```
robin install [--profile P] [--no-hooks] [--hooks-only] [--no-supervise] [--no-register] [--no-agents-md] [--no-start] [--force]
robin uninstall
robin mcp <start|stop|status|restart|ensure-running|install|uninstall>
robin doctor [--rebaseline|--purge-stale-sessions|--lint-hooks]
```

### Memory

```
robin remember [--force] <content>       # CLI memory write; --force bypasses inbound discretion
robin journal                            # recent capture
robin hot                                # hot entities / topics
robin rules pending                      # rule candidates awaiting approval
robin rules approve <id>
robin rules reject <id>
robin rules list
robin rules deactivate <id>
robin dream run                          # trigger nightly consolidation now
robin biographer-catchup [--retry-failed]
robin migrate                            # apply pending schema migrations
robin migrate-from-v1                    # one-shot import from v1
robin embedder switch <profile>          # switch + resumable re-embed
```

### Safety / sessions

```
robin sessions [--stale]                 # list active sessions, or purge stale
robin refusals list                      # recent in/outbound refusal audit
robin hooks <disable|enable> <phase>     # kill-switch a single hook (discretion, intuition, session-start, stop)
robin pre-commit <install|uninstall>     # per-repo privacy hook
robin hook <phase>                       # internal — invoked by host hook entries; not for direct use
```

### Integrations

```
robin integrations <list|status|run>
robin integrations discord register-commands
robin auth <google|spotify|whoop> [--code [<VALUE>]]
robin secrets <import --from <path>|list|set <KEY>>
```

## Develop

```sh
npm install
npm test                  # node --test on tests/**/*.test.js
npm run test:unit
npm run test:integration
npm run lint              # biome check
npm run format            # biome format --write
```

Full development guide — adding tools, integrations, hooks, migrations: [`docs/development.md`](docs/development.md).

## License

[MIT](LICENSE)
