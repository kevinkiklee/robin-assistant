# Architecture

Robin is a Node.js daemon that owns scheduling, memory, LLM dispatch, and the integration lifecycle. LLM-scale work runs in detached child processes the daemon spawns. It exposes itself as two stdio MCP servers that Claude Code (or any MCP client) connects to, plus an optional OAuth-protected HTTP surface for claude.ai connectors.

## Layers

```
system/                    Framework source (TypeScript, compiled to dist/)
├── kernel/                Daemon runtime, scheduler, health monitor + alert store, config, invariants
├── brain/                 memory/ (DB, migrations, ingest, recall, beliefs, entities),
│                          cognition/ (biographer, dream, embedder, capture, hygiene, behavior,
│                          recommendations, predictions, scouts, audits), learning/ (corrections),
│                          llm/ (providers + dispatcher)
├── agent/                 runAgent, usage ledger, worktrees, outcome verifiers, handlers A–L,
│                          auto-land gate + post-land probation
├── integrations/          Built-in integrations + runtime loader, OAuth helpers
├── jobs/                  Job runtime + built-in agent-runner job
├── skills/                Built-in skills + runtime loader
├── surfaces/              CLI, HTTP hook server, MCP servers (core, extension, remote)
├── lib/                   Shared: paths, logging, telemetry, discretion, notify, publish,
│                          sky/solar/lunar/tides, launchd, claude-hooks, mcp-config, notes, clock,
│                          secrets, power-auto, operator-profile, remediation-request, land-log
├── scripts/               Build helpers (extension compiler, build stamp), private-data scanner
└── tests/                 Architecture-boundary, golden, and integration tests

lab/                       Offline test lab (synthetic-life replay + scoring)
githooks/                  pre-commit (Biome format, private-data check), pre-push (re-scan)

user-data/                 Per-user instance data (gitignored)
├── config/                models.yaml, policies.yaml, hardware.yaml, recall-topics.yaml, secrets/
├── extensions/            User integrations, jobs, skills, scripts, triggers
├── content/               knowledge/, profile/, sources/, artifacts/
├── agent-runs/            JSONL transcripts + learning records from runAgent
├── state/                 db/robin.sqlite, runtime/ (pidfile, stamps, locks), primer.md
└── observability/         Daemon logs, eval data

dist/                      Compiled output (tsc + compiled extensions + build stamp)
```

`user-data/` resolves from `ROBIN_USER_DATA_DIR`, then an instance-pointer file written by `robin init` (`$XDG_CONFIG_HOME/robin/`), then `$XDG_DATA_HOME/robin`. User-data extensions are compiled in place by `pnpm build`.

## Process model

| Process | Entry | Notes |
|---|---|---|
| Daemon | `robin daemon --foreground` (launchd) | Scheduler, health monitor, HTTP hooks on `127.0.0.1:41273`, integration watcher |
| Cognition children | `brain/cognition/cognition-runner-entry.ts` | `biographer.run`, `dream.run`, `entity-hygiene.run`. Spawned detached; own their job row |
| Agent children | `agent/runner-entry.ts` | One `runAgent` handler run per `agent-runner` tick |
| MCP core / extension | `robin mcp core` / `robin mcp extension` | Spawned by Claude Code over stdio |
| MCP remote | `robin mcp remote [--port N]` | Streamable HTTP on `127.0.0.1:41274` by default |

None of these share memory or connections. Every entry point calls `loadEnvFile(userData)` and `openDb()` itself; forgetting `loadEnvFile` makes integrations skip with "not set".

## Database

A single SQLite file (`user-data/state/db/robin.sqlite`) via `better-sqlite3`, with `sqlite-vec` for vector search. Pragmas: WAL, `synchronous=NORMAL`, `busy_timeout=5000`, foreign keys on, and a 64 MB `journal_size_limit`. A versioned migration runner (`system/brain/memory/migrations/`, 40 migrations) applies the schema on every entry point. Never edit an applied migration; add a new one.

| Table | Purpose |
|---|---|
| `events` | The event log — captured sessions, integration ticks, belief updates (`belief.update`), predictions, telemetry. Facts supersede; they aren't edited. |
| `events_content` | Bodies, separated from `events` for scan efficiency. `embedding` is a marker that the row has been embedded. |
| `events_content_fts` | FTS5 index over content bodies. |
| `events_vec` | `vec0` table, `int8[3072]`, keyed by content rowid. Floats are quantized with a shared scale (`vec-quantize.ts`). |
| `entities` / `relations` / `entity_aliases` | Canonical entities with profiles, a personal-domain tag, and a normalized name. SPO triples link them. An alias map collapses name variants. |
| `belief_candidates` | Extracted claims awaiting promotion, with domain, confidence, provenance, and an embedding for dedup. |
| `predictions` | Claims with confidence, deadline, an optional structured resolution `spec`, resolution, and Brier delta. |
| `recommendations` | Advice with subject, verdict (buy/skip/wait/try/avoid), domain, confidence, expiry, status, and the event that fulfilled it. |
| `habits` | Inferred behavioral patterns: confidence, support across streams, contradictions, lifecycle (soft → graduated → retired). |
| `corrections` / `correction_embeddings` | What Robin got wrong and the fix, with an optional belief topic. Embedded for per-prompt recall. |
| `claim_failures` | Dead-letter queue for failed biographer claim extractions (bounded retry). |
| `biographer_progress` | In-flight chunk cursor for multi-tick extraction. |
| `jobs` | Scheduler queue (cron, manual, delayed). Terminal rows are pruned by retention. |
| `integration_state` | Per-integration KV and tick heartbeat (last attempt/ok, ingest count, consecutive errors). |
| `alerts` | Health incidents, deduped by open key, with the repair/escalation ladder fields. |
| `agent_usage` | Usage ledger: one row per agent run or pool-billed provider call, with label, status, cost, outcome, and compactions. |
| `recall_log` | Every recall call with its kept set, for the recall audit and the replay harness. |
| `journals` / `metrics_daily` | Nightly narrative and rolled-up metrics (calibration, open recs, recall precision, …). |
| `refusals` | Logged refusals with reason and action policy (read by `audit`). |
| `noise_blocklist` | Entity-hygiene blocklist. |
| `oauth_clients` / `oauth_codes` / `oauth_tokens` | Remote MCP authorization server state. |
| `linear_issue_map` | Linear write-back mapping. |

`audit_meta` (004) and `embedding_profiles` (002) still exist from early migrations, but no runtime code reads or writes them.

The `relations` table is the graph layer — SPO triples indexed on `(subject_id, predicate)` and `(object_id, predicate)`, traversed by `relatedEntities()`. At this scale, plain SQLite traversal is not a bottleneck, so there is no separate graph engine.

## Recall

`recall()` (`brain/memory/recall.ts`) runs in `lex`, `vec`, or `hybrid` mode (default when an LLM is available). Hybrid fuses the FTS5 and KNN lists with Reciprocal Rank Fusion (k=60). An L2 distance floor drops far vector hits, and lexical hits must be corroborated by vector distance where an embedding exists. A `kinds` filter is applied inside retrieval, over-fetching KNN candidates because `vec0` can't filter on the joined `events.kind`. FTS queries are sanitized. The embed policy (`embed-policy.ts`) keeps integration telemetry out of `events_vec`.

**Auto-recall** (`auto-recall.ts`) is the `UserPromptSubmit` path. Layer 1 maps keywords to whole canonical docs (`recall-topics.yaml`), with no embedding needed. Layer 2 adds recall snippets restricted to curated kinds, sliced to the relevant section. Separate, independently capped slices add relevant corrections, habit hints, and open recommendations. One query embedding is shared across all slices. Every failure degrades to injecting nothing.

**Primer** (`cognition/primer.ts`) is the `SessionStart` path: a materialized, LLM-free view of active corrections, belief heads, profile prose, and a doc index, hard-capped in size.

## LLM dispatch

Role-based routing defined in `user-data/config/models.yaml`. Roles: `interactive`, `agentic`, `reasoning`, `summarize`, `classify`, `embed`, `rerank`. Providers (`brain/llm/build-dispatcher.ts`):

| Provider | Use |
|---|---|
| `claude-agent` | Claude Agent SDK, subscription/pool-billed. Spend goes to the usage ledger (surface `provider`), not the dispatcher cap. Optional per-role `effort`. |
| `anthropic` | Messages API (`CLAUDE_API_KEY`). |
| `google` | Embeddings only (`GEMINI_API_KEY`); `embedDims` sizes output to the schema. |
| `ollama` | Local chat and embeddings. |

```yaml
roles:
  reasoning:
    provider: claude-agent
    model: claude-sonnet-5-5
    fallback: { provider: claude-agent, model: claude-opus-5-5 }
  classify: { provider: claude-agent, model: claude-sonnet-5-5, effort: low }
  embed:    { provider: google, model: gemini-embedding-2, embedDims: 3072 }
```

The dispatcher wraps every call in `withTimeout` (5 min invoke, 2 min embed, overridable per call) so a hung provider can't wedge a caller. A **daily USD cap** (`ROBIN_LLM_DAILY_USD_CAP`; default $10 when an `anthropic`/`google` role exists, else off) throws `SpendCapError`, which callers treat as an outage. A role's optional `fallback` is tried once, only when the primary reports a usage-limit error. Providers register leniently: a missing secret warns instead of crashing. Embed vectors must match `int8[3072]`; changing embedders requires `robin reindex --force`.

Non-agentic LLM work always goes through `llm.invoke(role, …)`. Agentic work goes through `runAgent` (below).

## Scheduler

The daemon's run loop calls `Scheduler.tickOnce()`, which claims and runs one pending job, then sleeps 1s (5s after a throwing tick). Key bounds (`kernel/runtime/daemon.ts`, `integrations/_runtime/scheduler-glue.ts`):

- **Lease 25 min**, above the **20-min per-handler wall-clock backstop**, so a live handler never outlives its lease. A 60s reaper and a boot-time sweep recover leases from dead workers.
- **Integration ticks** are wrapped in a 120s timeout.
- **Cron re-arm** (`rescheduleCronAfterCompletion`) runs on success and failure, so a transient error can't silence a schedule. Cron uses `ROBIN_TZ`, then the system TZ, then UTC.
- **Detached handlers** return `'detached'`: a child process now owns the row. It renews a short lease, enforces its own deadline, completes the row, and re-arms the cron even if the daemon dies mid-run. A single-flight lock prevents overlap; the daemon adds a fast-fail watch.
- Claiming stops while `power.state` isn't `active` or `network.mode` is `offline` (see [Policies and power](#policies-and-power)).

**Cognition jobs** (`brain/cognition/jobs.ts`):

| Job | Cron | What |
|---|---|---|
| `biographer.run` | every min (detached; skipped when there's no work) | Entity/relation/claim extraction from captured sessions. Chunked across ticks via `biographer_progress`. Personal-domain allowlist, harness scaffolding stripped, dead-letter queue for failed claims. LLM-unreachable aborts without advancing. |
| `embedder.run` | every min | Embeds un-embedded content in batches. |
| `ingest-docs.run` | */10 min | Indexes `content/knowledge` + `content/profile` (`.md`, `.html` as visible text). Content-hashed. |
| `behavior-reinforce.run` | 03:40 daily | Tier A habit reinforcement (deterministic). |
| `recommendation-link.run` | 03:45 daily | Links recommendations to evidence of action. |
| `dream.run` | 03:50 daily (detached) | Ordered steps: hygiene, predictions (spec resolver, then the unverifiable sweep), metrics, entities, arcs, expire, dedupe, lifecycle (promote/merge/conflict), topics (topic hygiene), depth, journal, freshness, claimRetry, staleDocs, docs, corrections (`applyCorrections`), digest. A `steps` allowlist lets the lab run subsets. |
| `reliability-audit.run` | 04:00 daily | Healed/recurred incidents, missed crons, stale integrations, per-invariant trends → dated artifact. |
| `doctor.run` | 04:15 daily | All doctor invariants with `fix: true`. |
| `retention.run` | 04:50 daily | Agent-run files and dated runtime files > 60 days; terminal job rows > 7 days; captured sessions > 90 days compacted to the operator's turns. |
| `behavior-synthesize.run` | Sun 05:00 | Tier B habit synthesis (LLM, ≥2 signal streams). |
| `recommendation-scan.run` | Sun 05:30 | Backfills unlogged recommendations; classifies open ones. |
| `scout-{finance,travel,health,career,social}.run` | Mon–Fri 05:30 | Domain scouts: digest → one structured call → gated recommendations. |
| `entity-hygiene.run` | Sat 05:30 (detached) | LLM-judged merge of duplicate entities. |
| `recall-audit.run` | 1st of month 05:00 | `recall_precision` / `recall_utilization` from `recall_log`. |

**User jobs** live in `user-data/extensions/jobs/<name>/` as `job.yaml` (schedule or `manual`, optional `tz`, permissions) + `index.ts` exporting `job.run(ctx)`. They run in-process under the 20-min backstop, bounded otherwise by their own LLM timeouts.

## Agentic runner

`system/agent/run-agent.ts` is the only sanctioned path to an agent loop. `claude -p` shell-outs and ad-hoc nested sessions are banned.

- **Surfaces and caps.** `agentic-on-demand` (`robin agent`, the extension `agent` tool) and `agentic-autonomous` (`agent-runner`) each have a daily USD cap, checked pre-flight against `agent_usage` (`policies.yaml` `agent.caps`). Each run also carries `maxTurns`, `timeoutMs`, and `maxBudgetUsd`.
- **Tools.** Explicit `allowedTools`. Read-only runs also set `disallowedTools` for the write builtins, which an allowlist doesn't gate.
- **Isolation.** Write handlers (A, J, K) run in a git worktree (`agent/worktree.ts`) under a fail-closed SDK sandbox (seatbelt on macOS, bubblewrap on Linux), with file checkpointing. Content handlers write only to their declared paths.
- **Result.** `success | capped | denied | timeout | error`, never a throw. It includes cost, turns, and the count of context compactions; a compacted run is treated as degraded.
- **Audit.** JSONL transcript per run in `user-data/agent-runs/`, plus a ledger row id.
- **Model.** Defaults to Opus 5.5 with a 1M context window at high effort. `ROBIN_AGENT_MODEL` overrides without a rebuild.

**Handlers** (`agent/handlers/`): A self-improvement, B research, C integration, D KB curation, E belief reconcile, F prediction calibrate, G gap fill, H dream enrich, I life executor, J integration author, K health remediate, L daily brief. Each emits a shared structured-outcome envelope that a per-handler deterministic verifier checks. Mismatches alert. The **`agent-runner`** job (every 3 h, `system/jobs/builtin/agent-runner/`) dispatches one autonomous handler per tick in round-robin (B, D, E, F, G, H, K) as a detached child. A pending remediation request from the nightly audit puts K ahead of the rotation. Pre-checks skip a spawn with nothing to do, and three consecutive failures bench a handler for three rotations. The whole runner is gated by `agent.enabled` (default `false`). L left the rotation and runs on demand only.

## Health monitor and alerts

The in-process monitor (`kernel/runtime/health-monitor.ts`) runs 13 of the 27 built-in invariants (`kernel/invariants/builtins/`) every 60s. Each check has a 5s timeout and an overlap guard. `dependsOn` folds a dependent's failure into a failing parent, for up to 6 hours.

- **Heartbeat.** `daemon.heartbeating` goes CRITICAL after 7 min without a scheduler tick. After 30 min of sustained CRITICAL, and at least 2 min of uptime, the monitor calls `exit(1)` for launchd respawn. Host sleep is detected (on macOS via a kernel sysctl probe, since the monotonic clock keeps counting in sleep), and the verdict is held for a post-wake grace period.
- **Boot classification.** Single-use shutdown stamps distinguish intentional restarts, system reboots, and crashes, so `daemon.stable` counts only crash-class boots.
- **Incident ladder** (`alerts` table): open → one repair attempt → escalate after 10 still-failing ticks → `needs-human` after 24 h escalated. Open incidents reach handler K through its rotation slot and through the nightly audit (see [Auto-fix loop](#auto-fix-loop)). A repair circuit breaker, keyed by build SHA, stops retrying a repair that failed twice on the current build.
- **Doctor.** `robin doctor [--fix] [--json]` runs 26 invariants (`kernel/invariants/doctor-set.ts`): everything but the monitor-only heartbeat, including checks too heavy to run every minute. Examples: `mcp.dist_current` (MCP servers running a stale build), WAL size, vector-index sync, bounded history tables and logs, orphan child processes, accumulated agent worktrees, and recall-topic doc paths. The doctor also prints per-integration health and runtime state.
- **Notifications.** Critical alerts go through `notifyOperator()` (below), with a 1-hour per-failure cooldown.

Integration invariants cover staleness against each cron's cadence (suppressed while power policy pauses work), degraded streams, unreachable APIs, and erroring jobs.

## Auto-fix loop

The nightly reliability audit hands its findings to handler K, and a verified K branch can land without review.

1. **Request.** `reliability-audit.run` (04:00) turns needs-human incidents, recurring repairs, circuit-broken checks, missed crons, stale integrations and flags into a goal (`remediationGoal()`), with the last 7 days of land attempts appended. It writes `state/runtime/remediation-request.json` (`lib/remediation-request.ts`). The request survives until K completes a run on it, up to 3 attempts, and goes stale after 24 h.
2. **Dispatch.** The next `agent-runner` tick runs K ahead of the round-robin, unless K is benched.
3. **Gate** (`agent/auto-land.ts`, `auto-land-fs.ts`). A branch lands only if every check passes; otherwise it stays a review branch. Scope: only reliability code (invariants, the health monitor and its helpers, the scheduler, the integration and job runtimes), never the agent runtime's import closure, surfaces, config, publish/discretion/notify, the audit itself, or migrations. Size: at most 8 files and 400 changed lines, with a test, and no overlap with uncommitted work. Reach: no new network, subprocess, secrets, env or dynamic-code access, no new imports in non-test code, and fs writes only inside a fresh `mkdtemp` directory. No loosening: no raised thresholds, downgraded severities, early passes or removed assertions in check code. Verify: typecheck, lint and the full suite run inside a seatbelt sandbox with a scrubbed environment; only failures new against the base count. Off macOS, nothing lands.
4. **Land.** Commit, merge into main, `pnpm build` (a failed build reverts), restart the daemon, then a 150 s probation (`land-probation.ts`) that reverts if the daemon isn't up and settled. Every land, hold and revert is appended to `state/runtime/auto-land-log.jsonl` (`lib/land-log.ts`).

Kill switch: `agent.auto_land: false` in `policies.yaml`. The gate is static analysis of model-written code: it narrows what a change can reach, it does not prove safety, and landed code runs unsandboxed in the daemon.

## Capture pipeline and hooks

`robin init` installs three Claude Code hooks (`lib/claude-hooks/install.ts`). Each is a curl to `127.0.0.1:41273` that fails silently when the daemon is down. The server refuses any request with a non-loopback `Host` or an `Origin` header, so a page in a local browser can't reach it.

- **SessionEnd** → `/hooks/session_end`. The daemon reads the transcript, projects turns, and calls `captureSession`. Skip rules: cwd outside the allowlist (`ROBIN_ALLOWED_CWDS`, default the directory containing `user-data/`), Robin's own internal SDK calls, no real assistant work (empty, tool-only, system notices), and gated pure-dev sessions. Survivors are deduped by content hash and written as `session.captured`. The `claude_code` integration rescans `~/.claude/projects` every 5 min as a fallback, capturing files only after they go idle.
- **SessionStart** → `/hooks/session_start` returns the primer.
- **UserPromptSubmit** → `/hooks/user_prompt_submit`. First, event-notes capture (`lib/notes/note-session.ts`): during a `>>note <slug>` session, prompts are appended to a raw note file and blocked from the model, until `>>end`. Otherwise it returns auto-recall context.

## Integrations

Each integration is a directory with `integration.yaml` (`name`, `version`, `schedule` or `manual`, optional `tz`, `permissions`, and an `mcp.actions` block with input schemas) and `index.ts` exporting `integration` (or a default) with `{ tick?, init?, cleanup?, health? }`, plus an optional `actions` map exposed as an MCP tool on robin-extension. The loader reads `system/integrations/builtin/` and `user-data/extensions/integrations/`, skips `_`/`.`-prefixed directories, registers crons, and hot-reloads user extensions on file change. A tick gets an `IntegrationContext` (`db`, `llm`, `state` KV, `log`, `fetch`, `now`, `ingest`, `checkOutbound`, and a `trigger` flag: `schedule` or `manual`). A `<name>--<instance>` directory runs a second instance under its own KV namespace. It normalizes data and calls `ingest()`, which dedupes by content hash.

Built-in: `gmail` (inbox + sent), `google_calendar`, `linear` (+ write actions), `weather` (Open-Meteo, moon and tide windows, directional sky reads and light alerts via `lib/sky`), `finance_quote`, `claude_code`, `notify` (macOS banner), `discord` (manual; outbound only). Chrome history is disabled (`_chrome`).

Google OAuth helpers live in `integrations/_auth/`. `robin reauth <name>` runs a one-shot localhost consent flow, writes the new refresh token to `secrets/.env`, and kickstarts the daemon.

## Notifications

`notifyOperator()` (`lib/notify/operator.ts`) fans out to the `notify` builtin (macOS banner) and the `discord` builtin in parallel. Neither can throw or suppress the other. Callers: health-monitor critical invariants, sky alerts (`lib/sky/deliver.ts`), and agent pause/credit-exhaustion notices (`agent/notify.ts`).

Discord is outbound REST only (`POST /channels/{id}/messages` with a bot token): no gateway and no `discord.js`. Actions: `notify` (channel post, optional operator mention), `dm`, and `digest`. A digest splits long documents on blank lines into ≤2000-char messages posted consecutively, and rewrites markdown tables into monospace blocks or bullets. Flags: `silent` → `SUPPRESS_NOTIFICATIONS`; `SUPPRESS_EMBEDS` is on by default. The User-Agent must follow the `DiscordBot (url, version)` shape, or Cloudflare rejects it with error 1010. Without `DISCORD_BOT_TOKEN`, the Discord side no-ops. Every message passes `checkOutbound()` (`lib/discretion/`), which refuses credential and PII shapes.

## Publish pipeline

`system/lib/publish/` turns a knowledge doc into a web page served by the companion `askrobin.io` app:

1. **Input.** A standalone HTML document by default (metadata in `<title>`, `<meta name="description">`, `robin:category`, `robin:slug`), or markdown with frontmatter (converted with remark/rehype, sanitized, wrapped in `template.ts`).
2. **Rewrites** (`html-page.ts`). Forces `noindex`. Strips `<base>`, refresh metas, and `robin:*` directives. Inlines local scripts and stylesheets, uploads local images and attachments (`ATTACHMENT_TYPES` in `files.ts`), and rewrites internal `/@<user>/<slug>` links to hashed URLs. It warns about anything the serving CSP or sandbox will block.
3. **Discretion gate.** Refuses credential shapes (including in scripts), PII shapes, and booking references. `--allow-sensitive` overrides a verified false positive.
4. **Write.** Vercel Blob (`BLOB_READ_WRITE_TOKEN`). The URL is `/@<user>/<slug>-<hash10>`, where the hash is an HMAC of `user/slug` keyed by `PUBLISH_URL_SECRET`: stable on republish, unguessable, and `noindex`, but not access-controlled. The local publish log is the only page list; no manifest blob is written.
5. **Web edits.** Deletes and recategorizations made in the dashboard arrive as encrypted ops that the per-user `life_sync` integration applies locally through `deletePage` / `recategorize`.
6. **Thumbnails** (`thumbs.ts`). A page's first photo is its preview; pages without one get a headless-Chrome screenshot (macOS only), retaken when `updated_at` changes.

Serving-side JavaScript runs under a CSP sandbox without `allow-same-origin`, so pages run at an opaque origin. The host allowlists in `config.ts` mirror the serving app's CSP and must change together. The category taxonomy (`config.ts CATEGORIES`) is likewise mirrored in the serving app. CLI: `robin publish --source <file> --slug <slug> [--category C] [--dry-run]`, `--mode recategorize|delete|thumbs`, and `robin published`.

## Recommendations and habits

`recommend` (core MCP) logs advice with a subject, a verdict (`buy`/`skip`/`wait`/`try`/`avoid`/`other`), domain, confidence and expiry. Logging a recommendation whose subject overlaps an open one supersedes it, and anything past 15 per session per day is stored `suppressed`. `recommendation-link.run` matches open recommendations against behavioral signals and order, shipping and booking emails, and expires the rest. `skip`/`avoid`/`wait` advice resolves `held` at expiry unless a matching action contradicts it, and `held` stays out of the acted rate. The weekly `recommendation-scan.run` backfills recommendations that were never logged and classifies open ones. Code: `brain/cognition/recommendations/`. CLI: `robin recommendations [dedupe --apply]`.

Habits (`brain/cognition/behavior/`) are inferred from the same signal streams. Tier A (`behavior-reinforce.run`, nightly) recomputes confidence deterministically and retires stale habits. Tier B (`behavior-synthesize.run`, weekly) proposes new habits with structured LLM output and needs support from at least two streams. A habit moves `soft` → `graduated` → `retired`. Auto-recall injects relevant habit hints and open recommendations as separate, capped slices. CLI: `robin habits`.

## Policies and power

`user-data/config/policies.yaml` is parsed by `kernel/config/schema.ts`. Every block has defaults, so a partial file is valid. The blocks that change runtime behavior:

- `power.state` (`active` / `paused` / `off`) and `network.mode` gate the scheduler. `offline` halts it; `local-only` claims only jobs that never leave the machine (`LOCAL_ONLY_JOBS` in `kernel/runtime/daemon.ts`: retention, doctor, the reliability audit) and leaves the rest pending until `online`. `robin pause|resume` and `robin offline|online` set them, and so does the `power` MCP tool (status only on the remote surface).
- `power.auto`: the power monitor (`lib/power-auto/`, decisions in `rules.ts`) checks every 30 s. It pauses below `on_battery_below_pct` (resuming on AC) and, with `on_low_power_mode: paused`, while macOS Low Power Mode is on. `quiet_hours: { start, end, mode }` (local time, may cross midnight) and `network.on_metered` switch `network.mode`; the strictest active rule wins. "Metered" is what macOS reports for the current path: expensive (Personal Hotspot, cellular) or constrained (Low Data Mode, set per Wi-Fi network). It's read by a small Swift helper built into `dist/` on macOS, since background processes can't read the SSID. Automatic changes record `set_by: auto`, a `reason` and the replaced `prior_mode`, which is restored when the last rule ends. A manual change holds until a rule next starts, and the monitor never loosens a stricter manual mode. The stall alarm (`scheduler.progressing`) stays quiet while the mode is under automatic control.
- `capture`: on/off with an optional expiry (`robin incognito`) and blocked paths.
- `agent`: `enabled` (default `false`), per-surface daily caps, session defaults, `auto_land`.
- `biographer`, `behavior`, `recommendations`, `scouts`, `alerts`, `notifications`, `linear`: per-subsystem tuning and kill switches.

## Privacy guard

The repository is public, and development sessions see real personal data. `system/scripts/private-scan.mjs` refuses personal data in tracked files: terms from the gitignored operator profile, people, medications and accounts from memory, deployment hostnames, phone/mailbox/last-4 shapes, 6-word runs shared with the operator's notes, corrections and beliefs, and SHAs of commits rewritten out of history. `githooks/pre-commit` runs it on staged files and `githooks/pre-push` re-checks every pushed commit, its message and its author. `node system/scripts/private-scan.mjs --tracked --deep` audits the whole tree. Values the code needs at runtime come from `lib/operator-profile.ts` and degrade gracefully when the profile is absent.

## MCP surfaces

- **Core** (`surfaces/mcp/core/server.ts`, server name `robin`), 22 tools: memory (`recall`, `remember`, `get`, `list`, `find_entity`, `related_entities`), beliefs (`believe`, `recall_belief`, `review_beliefs`, `resolve_belief_candidate`), learning (`predict`, `recommend`, `record_correction`), self-model (`audit`, `explain`, `health`, `metrics`, `journal`, `alerts`, `integration_status`), `power`, and `skill`. It hot-reloads in place when the `dist/` build stamp changes, swapping a dispatch table without restarting the stdio process.
- **Extension** (`surfaces/mcp/extension/server.ts`, server name `robin-extension`): `run`, `integration_status`, `ingest`, `related_entities`, `resolve_prediction`, `resolve_recommendation`, `agent`, plus one tool per integration exporting `actions` (`gmail`, `google_calendar`, `linear`, `finance`, `discord`, and user extensions). Integration-state output is redacted, and results from third-party-text integrations are fenced as untrusted content.
- **Remote** (`surfaces/mcp/remote/`): core over Streamable HTTP at `/mcp`, loopback-bound. Public reach needs a deliberate tunnel. A tool is exposed only if it is named in `READ_ONLY_TOOLS` (15) or `REMOTE_WRITE_TOOLS` (6 memory-ledger writes, `robin:write` scope only). The server is built with `readOnly: true` even for write grants, which disables the mutating branches of mixed tools. `agent`, `run`, and `ingest` are never remote. The six memory-ledger writes refuse credential shapes (`checkInbound`) on every surface. Auth is OAuth 2.1, with the server as its own authorization server: RFC 9728 protected-resource metadata, RFC 8414 metadata, RFC 7591 dynamic client registration, S256 PKCE, and rotating refresh tokens. `ROBIN_MCP_REMOTE_TOKEN` is the consent-screen access key and never reaches the client. `ROBIN_MCP_PUBLIC_URL` sets the absolute origin advertised in metadata. A 401 must carry `WWW-Authenticate: Bearer resource_metadata="…"`.

## Skills

Skills are markdown methodology files served by the `skill` tool on core. The loader scans `system/skills/builtin/` (`memory-curation`, `skill-authoring`, `web-research`) and `user-data/extensions/skills/`, parses `SKILL.md` frontmatter, and lets user skills shadow system ones. The catalog is embedded in the `skill` tool's description at server start, so the client sees what exists without a list call. Robin never executes skill scripts; the client does.

## Telemetry

`writeTelemetry` (`lib/telemetry/write.ts`) writes schema-validated events (kinds in `lib/telemetry/kinds.ts`) to `events`. Structured logs go through pino; under launchd the daemon's stdout lands in `observability/logs/daemon.log`.

## Test lab

`lab/` (`pnpm lab doctor | fixture | copy | score`) generates a synthetic life from a seed, using a slot-based life script with truth changes and disclosures. It replays the result one sim-day at a time through a sandboxed copy of the memory pipeline: capture, biographer, embedder, dream, hygiene, and assistant calls. A deterministic template LLM provider stands in for the model. Sandbox tripwires refuse opening a live database path, outbound `fetch`/`http(s)` egress, leaked env, and non-lab model providers. They are tripwires, not a jail (`lab/sandbox/guards.ts` lists the gaps). Sim time is pinned per SQLite connection (`lib/sql-clock.ts`). The scorer compares the resulting belief state against a knowable-truth oracle (head timeline, staleness, resurrection, phantoms). Arms differ only by tuning patches (`brain/memory/tuning.ts`), so one fixture feeds every arm. Nothing in the lab reads `user-data/` except the aggregate-only calibration script in `lab/calibrate/`.
