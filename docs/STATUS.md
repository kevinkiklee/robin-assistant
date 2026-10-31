# Robin — Implementation Status

> Snapshot: 2026-10-29 (privacy and security changes through 2026-10-31)
> Build state: `pnpm typecheck` and `pnpm lint` clean; `pnpm test` all pass locally (see [Test coverage](#test-coverage) for what that number includes).
> History note: the public repository's history was reset on 2026-10-31 to remove personal data. Commit hashes cited below refer to the earlier history and don't resolve on GitHub; `docs/design/` specs are the maintainer's local notes and aren't published.
> Companion: `docs/BACKLOG.md` (open work), `CLAUDE.md` (conventions and operating rules), `docs/ARCHITECTURE.md`.

Counts in this file come from the source tree on 2026-10-29, not from a running instance.

## What's running

Robin is one long-lived daemon on macOS under launchd (KeepAlive), plus processes the host spawns on demand:

- **Daemon** (`system/kernel/runtime/daemon.ts`): scheduler loop, integration ticks, in-process health monitor, HTTP hook receiver on `127.0.0.1:41273`.
- **Detached children**: `biographer.run`, `dream.run` and `entity-hygiene.run` run in their own process (`cognition-runner-entry.ts`) so LLM-latency work can't block the scheduler or outlive a lease. The agent runner launches each autonomous agent run as a detached child too.
- **MCP servers**: `robin mcp core` and `robin mcp extension` over stdio, spawned by Claude Code; `robin mcp remote` over Streamable HTTP for claude.ai connectors. Each opens its own DB handle and loads secrets itself.
- **Claude Code hooks**: SessionStart (primer), UserPromptSubmit (auto-recall and event-note capture), SessionEnd (capture). Installed by `robin hooks install`.

LLM work goes through `llm.invoke(role, …)` on a dispatcher (`system/brain/llm/`). Roles map to models in `user-data/config/models.yaml`. Shipped providers: `claude-agent` (Agent SDK on a subscription pool, the default for reasoning roles), `anthropic` (metered API), `google` (embeddings only), and an `ollama` adapter that is kept but isn't the default. Claude-only routing for reasoning has been policy since 2026-06-10. Model defaults moved to the Claude 5.5 family on 2026-10-26. Embeddings are 3072-dim, stored int8-quantized in sqlite-vec.

## Subsystems

### Memory (`system/brain/memory/`)
- **Event store**: append-only `events` + `events_content`, FTS5 plus int8 vectors (`events_vec`). Embedding runs later in a batch job, never on the ingest path. An embed policy (`embed-policy.ts`) keeps integration telemetry out of the vector index.
- **Recall**: hybrid lexical + vector with RRF, a `kinds` filter inside retrieval, safe FTS query building, lexical floors, and heading-aware section slicing for long docs. Every call is logged to `recall_log`, including the kept set.
- **Auto-recall**: a per-prompt injection through the UserPromptSubmit hook. It retrieves curated kinds only, skips harness prompts, gates sensitive docs, injects relevant corrections and an open-loops slice, and records every outcome.
- **Entity graph**: biographer-extracted entities and relations. Duplicates collapse on a normalized-name key (migrations 033–034) and a per-instance alias map (028). A weekly LLM-judged entity-hygiene pass merges one thing that appears under several names. Stale profiles are served as relation summaries, never as current truth.
- **Beliefs**: topic-keyed supersession via `believe` / `recall_belief`. They carry provenance, freshness and confidence decay, plus canonical topics (`canonicalizeTopic()` at the single write point). A nightly topic-hygiene pass collapses duplicate topics. Candidates are LLM-judged against their head when they diverge (`robin beliefs reconcile`), and stale conflicted candidates expire.
- **Domain gating**: a closed personal-domain allowlist (`domains.ts`). Engineering and dev content is dropped at extraction, at capture (`looksPureDev`), and at the promotion gate. Kill-switch: `biographer.domainGating`.
- **Corrections**: logged with an optional topic, and embedded so recall can find the ones relevant to a prompt (migration 040). Topic-linked corrections retract the contradicted belief nightly. `robin corrections topics` LLM-links topic-less ones.
- **Predictions**: a creation gate (stream freshness + per-run cap), plus structured resolution specs that a deterministic resolver checks against Robin's own data (migration 039). Brier scoring happens at resolution.
- **Recommendations + habits**: the `recommend` ledger (031) and behavioral habits (030); see Cognition jobs.
- **Hygiene + retention**: captured sessions older than 90 days are compacted to the operator's own turns. Credentials are redacted from sessions before storage. `robin memory prune-noise` drops denied-kind vectors. Doctor invariants bound every growing table.
- **Tuning seams**: belief-lifecycle constants sit behind `getTuning()` (`tuning.ts`). Pipeline time reads go through `system/lib/clock.ts` and `pinSqlClock`, so the test lab can run on simulated time.

Schema: 40 migrations (`system/brain/memory/migrations/001–040`).

### Cognition jobs (`system/brain/cognition/jobs.ts`)

18 scheduled cognition jobs:

| Job | Cron | What it does |
|---|---|---|
| `biographer.run` | every min | Entity/relation/claim extraction from captured sessions (multi-tick, child process, dead-letter retry) |
| `embedder.run` | every min | Embed rows with NULL embedding |
| `ingest-docs.run` | every 10 min | Index knowledge/profile docs into recall (content-hashed, idempotent) |
| `behavior-reinforce.run` | 03:40 daily | Habit Tier A: deterministic reinforcement and retirement |
| `recommendation-link.run` | 03:45 daily | Match open recommendations against behavioral and commerce-email signals; expire |
| `dream.run` | 03:50 daily | Prediction resolution, metrics rollup, staleness flags, candidate expiry, topic hygiene, correction replay |
| `reliability-audit.run` | 04:00 daily | Deterministic audit of healed/recurred incidents, missed crons, stale integrations → dated artifact |
| `doctor.run` | 04:15 daily | All invariants with `fix: true` |
| `retention.run` | 04:50 daily | Prune agent-run files and dated runtime files >60d, terminal job rows >7d; compact sessions >90d |
| `behavior-synthesize.run` | Sun 05:00 | Habit Tier B: weekly LLM synthesis |
| `recommendation-scan.run` | Sun 05:30 | Recover unlogged recommendations from sessions, then classify open ones |
| `scout-{finance,travel,health,career,social}.run` | Mon–Fri 05:30 | One domain scout per weekday: deterministic digest → one structured call → gated rec candidates |
| `entity-hygiene.run` | Sat 05:30 | LLM-judged entity merges (bounded, reversible) |
| `recall-audit.run` | 1st of month 05:00 | Sampled judge of auto-recall precision and utilization |

Per-user jobs (for example the daily brief and its wake-gated delivery) live under `user-data/extensions/jobs/` and run on the same scheduler. The built-in `agent-runner` job (`system/jobs/builtin/agent-runner/`) fires every 3 hours.

### Agents (`system/agent/`)
- All agentic `query()` calls go through `runAgent`. It is ledger-accounted, tool-allowlisted, capped by turns, time and budget, worktree-isolated for writes, OS-sandboxed (seatbelt/bubblewrap), and writes JSONL transcripts. Pool-billed `llm.invoke` spend and SDK auto-compactions are recorded in the same `agent_usage` ledger.
- 12 handlers, A–L (`system/agent/handlers/`). The autonomous rotation is B, D, E, F, G, H, K, one per tick. L left the rotation on 2026-10-02 and can still be run on demand with `robin agent --handler=L`.
- Each run returns a structured outcome envelope that a deterministic per-handler verifier checks (`verifiers.ts`). Pre-checks skip spawns that have nothing to do. Three consecutive failures bench a handler for three rotations and raise an alert. `robin metrics --agents` shows per-handler ROI.

### Surfaces
- **robin-core MCP**: 22 tools: `recall`, `remember`, `find_entity`, `get`, `related_entities`, `integration_status`, `list`, `predict`, `recommend`, `believe`, `recall_belief`, `review_beliefs`, `resolve_belief_candidate`, `record_correction`, `audit`, `explain`, `health`, `metrics`, `journal`, `power`, `alerts`, `skill`. Hot-reloads tool logic from a dist build stamp through a swappable dispatch table.
- **robin-extension MCP**: 7 ops tools (`run`, `integration_status`, `ingest`, `related_entities`, `resolve_prediction`, `resolve_recommendation`, `agent`), action dispatchers for 5 built-in integrations (`gmail`, `google_calendar`, `linear`, `finance`, `discord`), and one dispatcher per user extension that declares actions. It warns on every result when its build is stale, redacts OAuth tokens from output, and fences integration results as untrusted content by default (only market quotes and Discord send receipts are exempt). The `check_action` and `update` stubs were removed 2026-10-30.
- **Remote MCP**: OAuth 2.1 (its own authorization server, dynamic client registration, S256 PKCE, rotating refresh tokens; migration 032). `robin:read` serves 15 tools and `robin:write` adds 6 memory-ledger writes. It binds to loopback only.
- **CLI**: 31 top-level commands (`system/surfaces/cli/index.ts`): `agent`, `alerts`, `beliefs`, `biographer`, `corrections`, `daemon`, `db`, `doctor`, `entities`, `habits`, `hooks`, `import`, `incognito`, `ingest-archive`, `ingest-docs`, `init`, `mcp`, `memory`, `metrics`, `offline`/`online`, `pause`/`resume`, `predictions`, `primer`, `publish`, `published`, `reauth`, `recall`, `recommendations`, `reindex`. `doctor` absorbed the old `status` and `integrations` views. `upgrade` was removed in May: migrations apply on daemon start and on `init`.
- **HTTP** (`system/surfaces/http/server.ts`): `GET /health`, plus `POST /hooks/session_start`, `/hooks/user_prompt_submit` and `/hooks/session_end`.
- **Publish** (`system/lib/publish/`): HTML pages (the default since 2026-10-26) or markdown, sanitized and sent to Vercel Blob. Every page URL carries an HMAC hash. Index-page edits replay from a pending-op queue. A publish-time discretion gate refuses credential, PII and booking-reference shapes (`--allow-sensitive` overrides a verified false positive).
- **Notifications** (`system/lib/notify/operator.ts`): `notifyOperator()` fans out to a macOS banner and an outbound-only Discord REST post. Both pass through `checkOutbound()` first.
- **Event notes** (`system/lib/notes/`): zero-turn `>>note` capture through the UserPromptSubmit hook, re-bound across `/clear`.

### Skills
- 3 system skills ship in `system/skills/builtin/`: `memory-curation`, `skill-authoring`, `web-research`.
- User skills live in `user-data/extensions/skills/<name>/` (gitignored). A user skill shadows a system skill with the same name. The catalog is embedded in the `skill` MCP tool description.

### Integrations
- **8 active built-ins** (`system/integrations/builtin/`): `claude_code` (session capture, every 5 min, plus the SessionEnd hook), `gmail` (inbox + sent), `google_calendar` (including deletion propagation), `linear`, `finance_quote`, `weather` (Open-Meteo directional sky forecast, fog index, moon and tide windows, light alerts), `notify`, `discord`. `_chrome` is disabled (2026-06-09). `github` was removed in May.
- **Per-user extensions** live in `user-data/extensions/integrations/` (gitignored), with the same `integration.yaml` + `index.ts` contract. `pnpm build` compiles them in place.
- Shared runtime: chokidar hot-reload; multi-instance via `<name>--<instance>` directories; Google OAuth helper; a cross-process lease that single-flights token refreshes; provider-agnostic `robin reauth`; tick trigger provenance (schedule vs manual). Transient upstream errors (5xx/429, empty bodies) degrade to a skip, not a job error. Every tick runs inside a 120s `withTimeout`.

### Scheduler and reliability
- Cron re-arms after completion and after fast failures. A per-handler wall-clock cap stops one wedged job from stalling the loop. Retries leave breadcrumbs, and a bound invariant watches them.
- Leases: an in-process reaper, dead-worker recovery at boot, and a boot-sweep exemption for detached children.
- **Health monitor** (60s): 27 invariants (`system/kernel/invariants/builtins/`) covering daemon, DB (including WAL size), scheduler, jobs, integrations (staleness, degraded streams, unreachable), MCP dist currency, recall, capture volume, orphans and bounded tables. Dependent checks fold into failing parents.
- **Incident ladder** (migration 036): repair once, escalate once, then needs-human. A SHA-keyed repair breaker sits in front of it. Alerts are persistent and deduped, with severity escalation, auto-resolve and ack (`robin alerts`, MCP `alerts`).
- **Boot classification**: a single-use shutdown stamp tells clean restart, system reboot and crash apart. `daemon.stable` storm-counts crash-class boots only.
- **Host sleep**: detected through the kernel, because the macOS monotonic clock counts sleep. The daemon is not killed for heartbeat gaps that sleep explains, and wake gets a staleness grace window. An event-loop-lag monitor alerts when the loop blocks.
- **Nightly self-audit**: `reliability-audit.run` judges whether the self-healing actually worked. `doctor.run` heals safe issues every morning.

## Test coverage

- `pnpm test` on 2026-10-29: **3,262 tests, 0 failures, ~34s**. The suite glob also runs the gitignored per-user extension and script tests, so a fresh clone runs fewer.
- The committed tree has **274 test files** (259 under `system/`, 15 under `lab/`) holding about **2,380 test cases** (about 2,260 in `system/`, 120 in `lab/`).
- Notable suites: architecture invariants (`system/tests/architecture/`: layer boundaries, monotonic migrations, telemetry kinds); a golden characterization of the memory lifecycle (`system/tests/golden/`); a foundation smoke test (init → doctor → daemon → job → stop, with HOME isolated); every invariant, handler, verifier and migration with data transforms.
- **Test lab** (`lab/`, `pnpm lab`): replays a seeded synthetic life through a sandboxed copy of the memory pipeline (path, egress, env and provider tripwires) one sim-day at a time, then scores the beliefs it produced against what a perfect memory could know. Only template mode exists (deterministic provider, no network, no paid calls).

## Known gaps

See `docs/BACKLOG.md` for detail and evidence.

- Interactive `robin init`: `init` without `--yes` still exits with "not yet implemented".
- MCP `explain` returns placeholder stubs, and the remote surface leaves it out for that reason.
- Test lab Plan 3 (paid `config`-mode runs, answer layer, budget broker, bootstrap report) is not started.
- Behavioral-habit Phase 3 (feedback depth and surfacing) has no spec.
- Discord is outbound-only. Two-way chat would need a gateway process, and that is a separate decision.
- APFS snapshot backups and metered-network auto-pause are not built.

## Recent changes (since 2026-06-16)

Newest first. Commit hashes are representative, not exhaustive.

- **2026-10-28**: Host sleep detected via the kernel instead of the monotonic clock. WAL file capped with `journal_size_limit`. Agent fleet: F unblocked, K stops re-fixing work that is awaiting merge, outcomes reported honestly.
- **2026-10-26**: Standalone HTML pages became the default publish format: scripts run sandboxed, Google Fonts allowed, local assets inlined or uploaded. Agent SDK 0.3.301 and Claude 5.5 model defaults.
- **2026-10-19 → 10-21**: Robin test lab Plans 1–2: calibration query, sandbox, seeded life-script engine, knowable-truth oracle and probes, template renderer and provider, per-day copy loop, state-layer scorer, CLI (`lab/`). The system seams it needed: sim clock routing, `MemoryTuning`, prompt registry, dream-step allowlist, `openDb` guard hooks, golden memory-lifecycle test. Also design docs for a dashboard fed by Robin snapshots (design only).
- **2026-10-02 → 10-03**: Stability audit wave.
  - Memory: weekly entity hygiene; LLM belief reconcile; on-demand topic hygiene and live-head degating; correction embeddings and topic linking; session compaction; no vectors for telemetry; credential redaction at capture; recall precision fixes.
  - Predictions: structured resolution specs + deterministic resolver.
  - Recommendations: commerce-email signals, held/contrary stances, supersede + per-session cap, weekly LLM classify, dedupe CLI.
  - Reliability: `retention.run`; the daemon survives host sleep; wake grace and `integrations.unreachable`; event-loop-block alert and `content_ref` index; boot GC no longer wipes cursors; restore keeps live OAuth tokens; Agent-SDK transcripts are never captured.
  - Agents: K/J confined to their worktree by the OS sandbox; L out of the rotation; per-role SDK effort; pool-billed spend recorded.
- **2026-09-01 → 09-12**: MCP stale-build detection beyond the SHA, plus OAuth token redaction. Per-hook timeout on SessionEnd.
- **2026-08-22 → 08-31**: Event-notes capture and `/note compile`. Hashed page URLs, with the private-page store removed. Index-page delete and recategorize via pending ops. Discord restored as an outbound notification transport. Calendar deletions propagate. SDK auto-compactions recorded in the ledger. Nightly topic hygiene. Doctor bounds logs, candidate embeddings and `recall_log`.
- **2026-08-10 → 08-14**: Reliability program, steps 1–4.
  - Boot classification and shutdown stamps.
  - Biographer and dream moved to detached children.
  - Incident ladder and repair breaker.
  - Dist build stamp, `mcp.dist_current`, and core MCP hot-reload.
  - Orphan-child invariant.
  - Nightly reliability audit.
  - Biographer no longer spawns for an empty queue.

  Value-loops redesign, in the same window:

  - Recommendation creation gate and open-loops resurfacing.
  - Prediction creation gate.
  - Five domain scouts.
  - Recall replay harness, kept-set logging and monthly recall audit.
  - Normalized-name entity dedup.
  - Corrected values written back as live heads.
- **2026-08-03 → 08-08**: Remote MCP surface with OAuth 2.1. Gmail sent-mail sync. Tick trigger provenance. `user-data/scripts` brought under typecheck, lint and tests.
- **2026-07**:
  - OAuth: provider-agnostic `robin reauth`; cross-process refresh lease; reauth clears the auth-death latch.
  - Biographer: tick deadline enforced inside inner loops; JSON recovery from prose-wrapped replies; dead-letter flood fix.
  - The autonomous fleet had never run from the daemon (repoRoot was derived from cwd). Fixed.
  - Expiry for stale conflicted candidates.
  - Weather transient-error handling.
  - pnpm no longer prunes the native SQLite binding.
  - The smoke test isolates HOME.
- **2026-06-17 → 06-29**: Behavioral habit inference Phase 2. Recommendation→action loop Phase 1, plus session-scan backfill and CLI. Capture throttling and generic-topic link suppression. Weather re-sourced to Open-Meteo with the directional sky engine (`lib/sky`), light alerts, moon ephemeris, tide windows and ensemble confidence. Categorized publish index.
- **2026-06-01 → 06-16**: Phases A–D (below), plus: Claude-only routing with Gemini for embeddings only; structured output through the Agent SDK fixed; per-role usage-limit fallback; int8 vectors and a ~58% smaller DB; per-handler scheduler timeout; end of the heartbeat/lease-reap cycle; self-capture loop closed; entity alias map; pre-commit Biome format hook; auto-recall restricted to curated kinds with doc slicing.

## History (before mid-June)

May 2026 built v3 from scratch: SQLite + sqlite-vec in place of v2's SurrealDB, an NDJSON importer for v2 data, the scheduler, the biographer/embedder/dream jobs, both stdio MCP servers, the integration runtime, the skills system, the belief lifecycle (provenance, freshness, decay, correction replay), `ingest-archive`, and CI. It was then prepared for public release.

June ran four phases from one audit-driven spec (`docs/design/2026-06-10-trust-feedback-memory-design.md`):

- **A, trust and alerting**: a persistent `alerts` table, staleness and degraded-stream invariants, and a doctor freshness table.
- **B, agentic outcome loop**: structured outcomes, deterministic verifiers, adaptive dispatch and an ROI view.
- **C, memory quality**: belief canonicalization, risk-weighted freshness, a claim dead-letter queue and stale-profile handling.
- **D, domain-gated ingestion** (`docs/design/2026-06-16-domain-gated-memory-*`): a personal-domain allowlist at extraction, capture and promotion, plus the `robin memory degate` cleanup.
