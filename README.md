# robin-assistant v6 (alpha)

A personal AI memory layer for Claude Code and Gemini CLI, backed by an embedded multi-model database. Robin captures what you talk about, links it into a graph, consolidates it nightly, and serves it back through MCP — so the next session knows what the last one knew.

This is the SurrealDB-first rebuild of Robin. v1 (`robin-assistant@5.x`) remains daily-use Robin until cutover is comfortable; the migrator + safety floor shipped in alpha 8b/9.

## Status

`6.0.0-alpha.17` — five-layer `system/` tree (runtime, data, cognition, io, config) on top of the alpha.16 evolution work (intuition / biographer / heartbeat / discretion / dream / reflection / introspection faculties, MMR + per-hit reinforcement on recall, biographer batching, state inference, runtime hardening). Code-only restructure on top of alpha.16 — no schema or API changes.

See [`CHANGELOG.md`](CHANGELOG.md) for the per-phase delta and the design docs under [`docs/superpowers/specs/`](docs/superpowers/specs/) for architecture rationale.

## Key features

- **Short-term memory — the biographer agent.** After each agent turn (Stop hook), the biographer reads the new rows in `events`, makes one LLM call per event, and writes structured `entities`, typed edges (`mentions`, `about`, `works_on`, `participates_in`, `occurs_with`, `before`), and `episode` boundaries. This is the working-memory layer: each raw turn is normalised into who/what was discussed and how it links to prior turns.
- **Long-term memory — the dream agent.** Nightly at 4 AM (`process.env.TZ`), dream runs a multi-step pipeline over events stamped `dreamed_at IS NONE`: promotes durable facts into `knowledge`, mines recurring `patterns`, updates the user `persona`, segments long-running activity into `arcs`, and clusters corrections into `rule_candidates`. Events are then stamped `dreamed_at`, so re-running is idempotent.
- **Self-improvement and learning — the reflection loop.** Corrections captured via `record_correction` accumulate in the DB. Reflection (step 3 of the dream pipeline) clusters them (cosine ≥ 0.85, min 3 occurrences, 30-day window) into `rule_candidates`. You approve or reject with `robin rules approve <id>`; approved rules surface in `CLAUDE.md` / `GEMINI.md` on the next session start.
- **Multi-model storage with a graph database.** Robin runs on embedded SurrealDB v3 (default `surrealkv://`; `rocksdb://` and `mem://` also supported). One database and one query language (SurrealQL) cover: documents (`events`, `memos`, `persona`), a single generic `edges` table with composite-ID UPSERT for typed relations (`mentions`, `about`, `before`, `works_on`, `participates_in`, `occurs_with`, `derived_from`, `supersedes`, `contradicts`), per-(profile, surface) HNSW vector indexes, key-value runtime state (`runtime_*`), and time-ordered event streams. Graph traversal, vector kNN, and field filters compose in a single query — no application-level join layer between stores.
- **MCP as the agent interface.** Every agent-facing operation — `recall`, `remember`, `find_entity`, `related_entities`, `list_episodes`, `list_arcs`, `get_arc`, `list_journal`, `record_correction`, `run_biographer`, `run_dream`, plus per-integration tools (gmail, calendar, github, spotify, …) — is exposed as an MCP tool over SSE. Claude Code, Gemini CLI, and any other MCP-aware host talk to Robin the same way they talk to any other MCP server.

## Faculties at a glance

Robin's behaviour is organised into seven named faculties. Each maps to a specific mechanism and a small set of files. See [`docs/faculties.md`](docs/faculties.md) for the deep dive.

| Faculty | What it does | Lives in |
|---|---|---|
| **intuition** | UserPromptSubmit hook injects relevant memory into the next turn | `system/cognition/intuition/` |
| **biographer** | Per-turn: normalises new events into entities, edges, episodes | `system/cognition/biographer/` (incl. graph pipeline) |
| **heartbeat** | 60s tick: integration syncs, biographer queue, stale-session sweep | `system/runtime/daemon/heartbeat.js` |
| **discretion** | Refuses inappropriate writes (inbound), commands (bash), and outbound payloads | `system/cognition/discretion/` |
| **dream** | Nightly multi-step consolidation into knowledge, patterns, persona, arcs, rule candidates | `system/cognition/dream/pipeline.js` |
| **reflection** | Step 3 of dream — clusters correction events into rule candidates | `system/cognition/dream/step-reflection.js` |
| **introspection** | Daemon-boot integrity check against the install manifest baseline | `system/runtime/daemon/introspection.js`, `runtime_introspection_state` |

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
       via 3-stage cascade         works_on, before,           close on 30-min
       (exact → embedding          occurs_with,                quiet window
        → disambig)                participates_in
```

**Dream — long-term memory, nightly multi-step consolidation:**

```
events WHERE dreamed_at IS NONE
        │
        ▼
┌───────────────── Dream pipeline (nightly, 4 AM) ──────────────────┐
│                                                                    │
│   knowledge     →  durable facts                  →  knowledge     │
│   patterns      →  recurring shapes               →  patterns      │
│   reflection    →  cluster ≥3, cos ≥0.85, 30 day  →  rule_cand.    │
│   profile       →  long-running user model        →  profile       │
│   arcs          →  multi-episode activity         →  arcs          │
│   commStyle     →  inferred interaction model     →  persona       │
│   compaction    →  hot→archive aged-out memos     →  archive_*     │
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
git clone git@github.com:kevinkiklee/robin-assistant.git
cd robin-assistant
npm install
```

`npm install` runs a postinstall step that wires Robin up with safe defaults: home at `<repo>/user-data/`, `mxbai-1024` embedder, hooks + daemon supervisor + MCP host registration. To pick a different embedder or location, run `ROBIN_SKIP_INSTALL=1 npm install` and then `node system/bin/robin install` interactively.

Then **restart your Claude Code / Gemini CLI session** so it picks up the new MCP server and hooks. Verify with `robin doctor`.

Full walkthrough — including per-step skip flags, secrets, OAuth, Discord, pre-commit hook, and uninstall — in [`docs/install.md`](docs/install.md).

## Daily life

You don't talk to Robin directly — your agent does. After install, just use Claude Code or Gemini CLI normally. Robin:

- Injects relevant memory at the start of every turn (intuition on UserPromptSubmit)
- Refuses dangerous Bash commands (discretion: secrets-read, destructive-rm, `surreal sql` against the local DB, etc.)
- Refuses memory writes that contain credentials or secrets (inbound discretion)
- Captures the turn's content into events, biographs them into entities + edges + episodes, and consolidates nightly into long-term knowledge
- Surfaces rule candidates from your corrections after reflection clusters them

Outbound writes (`github_write`, `spotify_write`, discord replies) pass through `system/cognition/discretion/outbound-policy.js` (outbound discretion: PII / secrets / verbatim-untrusted-quote guards) and a per-tool sliding-1h rate limiter (default 10/hr).

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

For the full, always-current list of commands and subcommands, run:

```sh
robin --help
```

Help output is generated from the declarative registry at
[`system/runtime/cli/commands.js`](system/runtime/cli/commands.js) — every
leaf command's import, export, and help string lives there.

The most commonly used commands:

```
robin install                            # install hooks, MCP, daemon
robin uninstall                          # uninstall everything
robin doctor                             # health check
robin mcp <start|stop|status|restart>    # daemon control
robin remember <content>                 # CLI memory write
robin journal                            # recent capture
robin dream run                          # trigger nightly consolidation now
robin rules <pending|approve|reject|list|deactivate>
robin integrations <list|status|run>
robin secrets <import|list|set>
```

## Develop

```sh
npm install
npm test                  # node --test on system/tests/**/*.test.js
npm run test:unit
npm run test:integration
npm run lint              # biome check
npm run format            # biome format --write
```

Full development guide — adding tools, integrations, hooks, migrations: [`docs/development.md`](docs/development.md).

## License

[MIT](LICENSE)
