# AGENTS.md

Contract for AI agents (Claude Code, Gemini CLI, any other MCP host) that connect to Robin.

This file describes the behaviour Robin expects from you and the tools it exposes. The user's `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md` carry a regenerable `<!-- robin -->` block that summarises this for you on session start. This file is the source of truth.

## What Robin is

Robin is a personal memory layer that runs as a local MCP server (SSE on `127.0.0.1:<port>`). It owns an embedded SurrealDB v3 database under `<package_root>/user-data/db/`. Every conversation turn flows through Robin as an `events` row, gets biographed into a typed knowledge graph, and is consolidated nightly into durable knowledge, patterns, profile facts, and behavioural rules.

You interact with Robin in three ways during a session:

1. **You receive injected context** — a `<!-- relevant memory -->` block appears at the top of your context each turn (the `intuition` faculty). Treat it as background you already know; do not quote it back to the user verbatim.
2. **You call MCP tools** — read memory, write memory, query integrations, run write actions on external systems.
3. **Your bash commands and writes are filtered** — the `discretion` faculty refuses dangerous commands and credential-shaped writes. If a tool call comes back with `{ok: false, reason: 'pii:...'}` or your Bash exits with code 2 and a `Robin: blocked` stderr line, you've hit it.

## Available MCP tools

### Memory — read

- **`recall(query, k?, recency_days?, since?, source?)`** — HNSW vector search over events. Returns `{hits: [{id, content, ts, source, meta, score}, ...]}`. Use this first when you need to know what happened recently.
- **`find_entity(name)`** — 3-stage entity resolution (exact → embedding → disambiguation). Returns the `entities` row or `null`.
- **`get_entity(id)`** — fetch by id with edges.
- **`related_entities(entity_id, edge_kind?, limit?)`** — graph traversal: returns adjacent entities by edge type (`mentions`, `works_on`, `participates_in`, `co_occurs_with`, etc.).
- **`get_knowledge(query?, limit?)`** — dreamed-up durable facts. Vector search if `query` is provided.
- **`get_profile()`** — the long-running user model (preferences, role, recurring topics).
- **`get_hot(limit?)`** — top entities by recent mention weight.
- **`list_episodes(limit?, since?)`** — recent episode summaries.
- **`list_threads(limit?, status?)`** — active and archived conversation threads.
- **`list_journal(limit?)`** — recent captured events as a linear log.
- **`list_patterns(limit?)`** — dreamed-up recurring patterns.
- **`list_rules(status?)`** — `pending`, `active`, or `all` rule candidates.
- **`list_jobs()`** — scheduled internal jobs.

### Memory — write

- **`remember(content, meta?)`** — capture a fact or observation. Passes through inbound discretion. Refused on credential / secret / private-key / JWT patterns.
- **`record_correction(content, target?)`** — capture a user correction. Same discretion check. After ≥ 3 similar corrections accumulate (cosine ≥ 0.85, 30-day window), reflection drafts a rule candidate.

### Operations

- **`run_biographer()`** — drain the pending-events queue now. Normally fires automatically on the Stop hook.
- **`run_dream({knowledge?, reflection?, profile?, threads?}?)`** — trigger nightly consolidation now. Normally fires at 4 AM.
- **`run_job(name, args?)`** — manually run an internal job (subject to `manually_runnable` gate).
- **`update_rule(id, action, ...)`** — approve / reject / deactivate / set-priority on a rule or rule candidate.

### Per-integration

Tool availability depends on which integrations are configured. Check `health` for the live list. Common shapes:

- `gmail_search(query, k?)`, `gmail_thread(id)`
- `calendar_upcoming(days?)`, `calendar_search(query)`
- `drive_search(query, k?)`
- `github_search_issues(query)`, `github_write_*` (writes — rate-limited)
- `spotify_recent(limit?)`, `spotify_write_*` (writes — rate-limited)
- `linear_search_issues(query)`
- `lunch_money_summary({period})`
- `whoop_today`, `whoop_recent`
- `youtube_list_subscriptions`, `youtube_list_liked`

### Audit and meta

- **`health()`** — daemon status, port, tool count, integration availability.
- **`integration_run(name)`** — manually trigger a sync.
- **`integration_status()`** — last-run, cursor, backoff per integration.
- **`check_action(...)`**, **`update_action_policy(...)`** — trust/action policy management.
- **`audit(...)`**, **`ingest(...)`**, **`lint(...)`** — administrative.

## How to use the tools well

**Prefer reading existing memory before asking.** When the user references a person, project, or topic by name and you don't have it in your injected context, call `find_entity` or `recall` first. Asking the user to repeat something Robin already knows is wasted turns.

**Record corrections explicitly.** When the user corrects your behaviour ("don't do X", "always do Y", "use Z instead of W"), call `record_correction` with their wording. Three of these clustering on the same topic become a `rule_candidate` they can approve — that's how Robin learns.

**Don't over-write memory.** `remember` is for durable facts and decisions, not session noise. The conversation itself is already captured by the Stop hook through the biographer; you don't need to manually re-capture turns.

**Treat injected memory as context, not citation.** The `<!-- relevant memory -->` block at the top of your turn is signal to inform your response. Don't quote it back to the user as if reporting findings — they wrote most of it.

## What Robin refuses

The `discretion` faculty enforces three guards. Knowing what they look like avoids confusion when one fires.

### Inbound discretion (memory writes)

- Refuses `remember` / `record_correction` content that matches credential / secret / private-key / JWT / password-assignment patterns.
- Returns `{ok: false, reason: 'pii:<pattern>'}`.
- You cannot override. Escalate to the user — they can run `robin remember --force <content>` from the CLI if it's a false positive.

### Bash discretion (PreToolUse)

- Refuses Bash commands matching: `secrets-read`, `env-dump`, `destructive-rm`, `low-level-fs`, `git-expose-userdata`, `eval-injection`, `db-direct-access`.
- Exits 2 with a stderr line: `Robin: blocked Bash — <rule>: <why>`.
- You cannot override. If the command was legitimate, ask the user — they can disable the hook (`robin hooks disable discretion`) or run it themselves.

### Outbound discretion (write tools)

- Refuses `github_write_*`, `spotify_write_*`, `discord_send` payloads matching PII patterns or verbatim quotes from untrusted recent events.
- Returns `{ok: false, blocked_by: 'pii:...'}` or `'verbatim:...'`.
- Rate limit: 10 writes per tool per hour (sliding window). Exceeding returns `{ok: false, blocked_by: 'rate_limit'}`.

All refusals are logged to the `refusals` table with `direction in ['inbound', 'outbound']`. The user can audit with `robin refusals list`.

## Behavioural expectations

- **Latency:** MCP calls are local SSE. Treat them as inexpensive — sub-100ms typical, no network. The `intuition` injection has a 300ms hard cap and fails open.
- **Idempotence:** `remember` deduplicates on content hash. Re-calling with the same content is a no-op.
- **Fail-soft:** every hook fails open. If Robin is offline (daemon stopped, port unreachable), turns still complete; you just don't get injected memory or refusal protection. Don't catastrophise — verify status with `health` if confused.
- **One Robin per user:** the daemon is single-process. Multi-session host coordination happens through `runtime_sessions`. If you see "session N of N" in stderr at session start, that's normal — Robin is tracking you alongside any other open hosts.

## Rules surfacing

After the user approves rule candidates (`robin rules approve <id>`), the approved rules are merged into the `<!-- robin -->` block of `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md` on the next session start. Treat those rules as instructions from the user — they were written from clusters of explicit corrections.

## Where to learn more

- [`README.md`](README.md) — entry point + key features
- [`docs/architecture.md`](docs/architecture.md) — how Robin is structured, the agent-turn walkthrough
- [`docs/faculties.md`](docs/faculties.md) — per-faculty deep dive (intuition, biographer, heartbeat, discretion, dream, reflection, introspection)
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — common failure modes
