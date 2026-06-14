# Robin — Deferred Work Backlog

> Date created: 2026-05-19
> Audience: future agent picking up where the initial build left off
> Companion: `docs/STATUS.md` (what's done), `docs/specs/2026-05-18-robin-v3-design.md` (architecture baseline)

This backlog is the actionable companion to `STATUS.md`. Each item below has scope, dependencies, files to touch, and acceptance criteria — enough for a fresh subagent to execute without reading the full conversation history.

**How to use:** Work top-down within a priority band. Items within a band are roughly independent. Cross-band dependencies are called out per item.

---

## Update — 2026-05-20 (v2 migration + embeddings + integration scaffolding session)

This session shipped the v2 → v3 data migration (rebuilt from scratch as NDJSON pipeline after finding the original SurrealDB-direct migrator broken at three layers), wired qwen3-embedding:8b at 4096-dim, moved embedding off the ingest hot-path into a deferred batch job, fixed the cron-TZ + daemon-install + health-monitor-notification bugs, and removed GA from scope. A parallel agent scaffolded 12 of 13 v2 integrations as extensions. Current test count: **244 passing**.

### Shipped this session (2026-05-20)

- **v2 migration rebuilt** as NDJSON. `tools/v2-export.mjs` (one-off, lives outside v3) dumps surrealkv tables → NDJSON; `robin import <dir>` ingests events/entities/edges/corrections/predictions through the v3 schema in a single outer transaction. Old `system/surfaces/cli/migrate/` deleted.
- **Embeddings live** — `qwen3-embedding:8b` at 4096-dim. Migration 005 reshaped `events_vec` from `float[1024]` → `float[4096]`. `embed-content.ts` helper truncates bodies > 30k chars before embedding (qwen3's runtime context is lower than the model's advertised 40k tokens). 9,452 / 9,453 events embedded; only failure was a single 130k-char daily-briefing pre-truncation-helper.
- **Embedding moved to deferred batch** — `system/brain/cognition/embedder.ts` runs every minute via the scheduler, picks up `events_content WHERE embedding IS NULL` in batches of 200. Ingest no longer blocks on Ollama. Frees high-frequency integration ticks.
- **`robin reindex`** verb with `--limit`, `--force`, `--ids`, `--batch`, `--json`.
- **Cron TZ fix** — `system/kernel/scheduler/cron.ts` resolves TZ from per-job `tz:` manifest field → `ROBIN_TZ` env → system IANA → UTC fallback. Pending rows refresh in-place when the TZ change moves the next-run time.
- **Daemon-install path fix** — `buildDaemonSpecFromEnv` resolves `userDataDir` to absolute (was passing relative paths into the plist; launchd's `/` cwd then made daemon die exit 78).
- **Health-monitor notifications** wired through `policies.notifications.health` (default on), re-read per tick so toggling the policy takes effect without daemon restart.
- **Daily-brief job** scheduled, fired today, captured today's brief at $2.17 cost. Lives at `user-data/extensions/jobs/daily-brief/`.
- **12 v2 integrations** scaffolded by parallel agent under `user-data/extensions/integrations/`: discord, ebird, google_drive, letterboxd, lrc, lunch_money, nhl, photos, spotify, spotify_write, whoop, youtube.
- **GA removed from scope** — references stripped from daily-brief protocol + this backlog.

## Update — 2026-05-19 (full backlog sweep)

A follow-up session implemented all P0 items (except hands-on-hardware validation), the highest-leverage P1 items, and the open-source tooling files.

### Shipped in this sweep

- **P0.1 scheduler wiring** (`1093a4f`) — daemon registers `biographer.run`, `dream.run`, `integration.<name>.tick` handlers and seeds cron schedules on boot
- **P0.2 all 6 remaining Tier-1 integrations** (`7995a90`, `5b7efb3`, `f9cb7fe`, `3e6569a`, `37957a9`, `951b198`) — github, linear, finance_quote, gmail, chrome, google_calendar + shared Google OAuth helper. Each has tick + health + MCP actions + tests.
- **P0.3 SurrealDB read path in migrate** (`28a98cf`) — `migrateDerivedData()` connects to v2 RocksDB, discovers tables, transforms event/entity/relation/prediction/correction rows with table-level error tolerance
- **P1.1 robin-extension MCP server** (`9ee1ed1`) — 6 integration action-dispatchers + 7 ops tools (run, integration_status, ingest, related_entities, resolve_prediction, check_action, update)
- **P1.3 hot-reload watcher** (`1c84756`) — chokidar with 200ms debounce, wired into daemon lifecycle
- **P1.5 (partial) notify built-in** (`56c0148`) — macOS osascript notification integration. Full unhealthy-trigger path (auto-fire on restart-loop) still deferred — see remaining items below.
- **T.1 GitHub Actions CI** (`d722c5a`) — `.github/workflows/tests.yml`: typecheck + lint + test + gitleaks + smoke
- **T.2 Docker image** (`d722c5a`) — `Dockerfile` + `.dockerignore`, Node 24 base, multi-arch via standard `node:24-slim`
- **T.5 db backup/restore/vacuum CLI verbs** (`2005161`) — `robin db backup [--path=…]`, `robin db restore --from=…`, `robin db vacuum`
- **T.7 README + CONTRIBUTING + SECURITY** (`d722c5a`) — full project documentation surface
- **Bonus: `robin mcp install` + launchd autostart** (`33deb49`) — runnable MCP install path that wires Robin into `~/.claude.json` AND registers daemon as launchd user agent (covers most of T.3 launchd plist generator)

### Update — second full sweep

Eight more items shipped:

- **P1.4 biographer stage 3** (`ac7f774`) — LLM-driven entity disambiguation when multiple candidates match; falls back gracefully without LLM
- **P1.5 auto-fire on daemon unhealthy** (`b97f1c2`) — `HealthMonitor` polls invariants every 60s; on critical failure with 1h cooldown, calls notify integration (opt-in via flag)
- **P2.1 Kuzu graph projection** (`cacb8f0`) — `rebuildKuzuProjection()` + `queryKuzu()` library functions; nightly rebuild job can land later *(removed 2026-06-11 — upstream archived, never wired; see P2.1 below)*
- **P2.2 OTel exporter** (`260fd44`) — `exportRecentEventsAsOtel()` posts events as OTLP HTTP spans to any compatible collector (Honeycomb, Grafana Cloud, etc.)
- **P2.5 multi-account integrations** (`1fcd75d`) — `<name>--<instance>` directory naming pattern; loader and scheduler-glue both honor `instanceName`
- **P2.6 battery threshold auto-pause** (`ba7568d`) — `PowerAutoMonitor` reads `pmset -g batt` every 30s; pauses on `on_battery_below_pct`, auto-resumes on AC
- **T.4 `robin upgrade` CLI verb** (`a247fb0`) — applies pending migrations with backup + `--dry-run`
- **T.6 companion repo template** — `docs/companion-repo-template.md` documents the full `robin-personal` skeleton including age-encrypted secrets + restic state sync

### Truly still deferred (the residual list)

- **Integration end-to-end validation** — each of the 12 extension integrations is scaffolded but needs the user's tokens (OAuth flows, API keys) to confirm a real tick lands events as expected. Cannot be done by an agent alone.
- **P1.2 interactive `robin init`** — TTY prompts + OAuth device flow + model pulling. ~2-3 day standalone UX project. The non-interactive `--yes` path covers all daily-driver use today.
- **P2 items (APFS snapshots, DSPy sidecar, Codex SDK)** — explicitly deferred by the operator. Current `wal_checkpoint + VACUUM INTO` backup, correction-replay few-shot, and Claude-Code CLI adapter all cover the value.

That residual list is the genuine "needs more thought" set — every item either requires hands-on operator participation or is a significant standalone project.

The original section structure below has the full per-item context (scope, files, acceptance criteria) for anyone picking up the remaining work.

---

## P0 — Required to make Robin a daily driver

These unblock the user's actual workflow. Without these, the daemon runs but doesn't *do* anything autonomously.

### P0.1 — Wire cognition + integrations into the scheduler — ✓ SHIPPED (commit `1093a4f`)

**Why deferred:** Plan 4 (biographer/dream) and Plan 5 (weather) shipped as functions you can call but the daemon doesn't register them as scheduled handlers. The scheduler infrastructure (Plan 1) supports cron + manual triggers but no jobs are currently registered.

**Scope:** Make `Daemon.start()` register handlers for the canonical jobs and seed their cron schedules on boot.

**Files to modify:**
- `system/kernel/runtime/daemon.ts` — in `start()` after building `this.scheduler`, register handlers and call `scheduleCronJob` for each
- `system/brain/cognition/jobs.ts` (new) — small wrapper that exports `registerCognitionJobs(daemon, db, llm)` and the cron schedules
- `system/integrations/_runtime/scheduler-glue.ts` (new) — `registerIntegrations(daemon, db, llm)` that loads integrations from `system/integrations/builtin/*` and `user-data/extensions/integrations/*`, registers a handler per integration (`integration.<name>.tick`), and schedules them per their `integration.yaml` `schedule` field

**Schedules to register on boot (idempotent via `scheduleCronJob`):**
- `biographer.run` — `*/15 * * * *` (every 15 min)
- `dream.run` — `0 3 * * *` (03:00 local)
- `integration.<name>.tick` — read from each integration's `integration.yaml` `schedule` field

**Acceptance criteria:**
- Running `pnpm dev` for 60s and then inspecting `state/db/robin.sqlite` shows scheduler claimed and ran `biographer.run` (no captures yet means 0 work) and at least one integration tick attempt.
- A new test under `tests/integration/cognition-wired.test.ts` that starts the daemon, posts a `POST /hooks/session_end` with synthetic transcript, waits, and asserts a `session.captured` event was written.
- `robin status` shows the registered jobs.

**Estimated:** 1 subagent task. ~2-3 hours of agent work.

---

### P0.2 — Tier-1 integrations — PARTIAL (3 of 6 shipped)

**Status:** github (`7995a90`), linear (`5b7efb3`), finance_quote (`f9cb7fe`) are in. **Remaining: gmail, google_calendar, chrome.**

**Why partially deferred:** gmail + calendar share Google OAuth — needs a small `system/integrations/_auth/oauth-google.ts` helper built once. chrome reads `~/Library/Application Support/Google/Chrome/Default/History` (a SQLite file Chrome writes) and has no network at all — independent of the others.

**Scope:** Build each integration following the `system/integrations/builtin/weather/` pattern. Each is `integration.yaml` + `index.ts` + `index.test.ts`. ~150-300 LOC apiece.

**Per-integration directories to create under `system/integrations/builtin/`:**

| Integration | API | Auth | Notes |
|---|---|---|---|
| `gmail` | Google Gmail API | OAuth 2.0 refresh-token flow | Reads inbox, labels messages. Secrets: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`. Network allowlist: `gmail.googleapis.com`, `oauth2.googleapis.com` |
| `google_calendar` | Google Calendar API | OAuth 2.0 (same flow as gmail) | Read events, create events. Same Google OAuth credentials. |
| `github` | REST API | Personal access token | `GITHUB_TOKEN`. Allowlist `api.github.com`. Tools: notifications, recent activity |
| `linear` | GraphQL API | Personal API key | `LINEAR_API_KEY`. Allowlist `api.linear.app`. Tools: active issues, get issue |
| `chrome` | macOS `~/Library/Application Support/Google/Chrome/Default/History` (SQLite read) | Filesystem only | No network. fs read permission for that path. Read recent visits |
| `finance_quote` | yfinance HTTP (or alpha vantage) | None (free tier) | Allowlist `query1.finance.yahoo.com`. Tools: latest quote, history |

**Shared work (do once, then reuse):**
- `system/integrations/_auth/oauth-google.ts` — refresh-token → access-token flow (used by gmail + calendar). Cached in `integration_state` per integration via the existing KV.
- `system/integrations/_auth/types.ts` — `OAuthCredentials`, `BearerToken` types

**Per-integration acceptance criteria:**
- `integration.yaml` declares all required `permissions.secrets`, `permissions.network`, and `mcp.actions`
- `tick()` ingests at least one event per successful sync with a clear `kind` like `integration.gmail.message`
- `health()` returns ok when secrets present and reachable
- Tests use mocked `fetch` (via `_test-server.ts` pattern) — never hit real APIs in CI
- MCP actions registered for at least 2 read operations per integration (e.g., `gmail(action="search")`, `gmail(action="get_thread")`)

**Estimated:** 6 subagent tasks, ~2 hours each. Can be parallelized (each integration touches its own directory).

**Dependency:** None for the integration code itself. Optional: P0.1 (cron wiring) so they actually run on schedule.

---

### P0.3 — Complete the SurrealDB read path in migrate

**Why deferred:** The Plan 7 migration tool ships with the flatfiles + verify phases working, but the `derived` phase has a stub that reports "deferred". Without this, v2 events / entities / predictions / corrections don't carry over.

**Scope:** Implement `migrateDerivedData()` in `system/surfaces/cli/migrate/from-v2.ts` to read v2's SurrealDB and transform rows into Robin tables.

**Files to modify:**
- `system/surfaces/cli/migrate/from-v2.ts` — replace the stub `migrateDerivedData()` with a real implementation
- `system/surfaces/cli/migrate/surreal-reader.ts` (new) — encapsulates SurrealDB connection + queries, isolated for testability

**Implementation outline:**
```ts
import { Surreal } from 'surrealdb';
import { surrealdbNodeEngines } from '@surrealdb/node';

const db = new Surreal({ engines: surrealdbNodeEngines() });
await db.connect(`rocksdb://${v2DbDir}`);
await db.use({ namespace: 'robin', database: 'main' });

const events = await db.query('SELECT * FROM event ORDER BY ts');
const entities = await db.query('SELECT * FROM entity');
const predictions = await db.query('SELECT * FROM prediction');
// ... etc
```

For each v2 row class, write a transformer that produces v3 rows. The shape will need inspection of v2's actual schema — look at `~/workspace/robin/robin-assistant-v2/system/data/db/` for table definitions.

**Acceptance criteria:**
- Running `pnpm tsx system/surfaces/cli/migrate/run.ts ~/workspace/robin/robin-assistant-v2 --dry-run` reports `derived: {ok: true, count: N}` where N matches v2's event count.
- Without `--dry-run`, those rows actually land in the v3 SQLite.
- Verify phase confirms row-count parity (±some tolerance for derived rows that don't translate).
- Re-running the migration is a no-op (idempotency via content-hash).
- New tests in `migrate/from-v2.test.ts` that use a synthetic SurrealDB fixture (or mock the Surreal client) to verify transformation logic without requiring v2 data.

**Estimated:** 1 subagent task. ~3-4 hours. The hardest part is reading v2's actual schema; once that's clear, transformation is mechanical.

---

### P0.4 — Validate end-to-end with a real Ollama model

**Why deferred:** All adapters are tested against mocks. The full agent loop — Claude Code → robin-core MCP → biographer extract via real Ollama → SQLite write — has not been exercised.

**Scope:** Smoke verify on a real machine with real Ollama models.

**Steps:**
1. `ollama pull qwen3.6:35b-a3b-mlx-q4` (or whatever the current best Qwen 3.x is)
2. `ollama pull qwen3-embedding-4b-mlx-q4`
3. Edit `user-data/config/models.yaml`:
   ```yaml
   roles:
     embed: { provider: ollama, model: qwen3-embedding-4b-mlx-q4 }
     classify: { provider: ollama, model: qwen3.6:35b-a3b-mlx-q4 }
     reasoning: { provider: ollama, model: qwen3.6:35b-a3b-mlx-q4 }
     interactive: { provider: claude-code }
   ```
4. Run `pnpm dev` and send a real session capture via `curl POST /hooks/session_end` with synthetic content
5. Wait for biographer to run; inspect `entities` table for extracted rows; inspect `events_content.embedding` column for populated blobs

**Acceptance criteria:**
- A `session.captured` → `biographer.extracted` event chain completes without errors
- `entities` table has rows
- `recall("query")` returns hits with non-zero vector scores
- No JSON parse errors in `daemon.log` (the v2 failure class)
- Document any discovered issues + fixes in `STATUS.md`

**Estimated:** 1 subagent task with hands-on hardware. ~1 hour once models are pulled.

---

## P1 — Quality of life / completeness

### P1.1 — `robin-extension` MCP server

**Why deferred:** Plan 3 shipped `robin-core` (user-scope, 13 tools). The complementary `robin-extension` (project-opt-in, ~18 tools) was intentionally deferred until integrations exist (P0.2).

**Scope:** Mirror of `robin-core` shape, with integration tools dispatched via action enum.

**Files to create:**
- `system/surfaces/mcp/extension/server.ts` — mirror of `core/server.ts`
- `system/surfaces/mcp/extension/run.ts` — stdio entry (called by `robin mcp extension`)
- `system/surfaces/mcp/extension/server.test.ts`

**Tools to register:**
- Integration action-dispatchers: `gmail(action, params)`, `calendar(action, params)`, `github`, `linear`, `chrome`, `weather`, `finance` — each builds its tool from the loaded integration's `mcp.actions` field
- `run(type, name?, params?)` — biographer / dream / job / integration
- `integration_status(name?)`
- `check_action(action, params)`
- `ingest(source, payload)`
- `related_entities(entity_id, hops?)`
- `resolve_prediction(id, outcome, evidence)`
- `record_outcome(prediction_id, ...)`
- `update(target, id, changes)` — rule / policy
- `archive(before)`
- `compare_models(role, task, providers)`
- `publish(source, slug?, mode?)` — optional, only if Vercel Blob is configured

**Files to modify:**
- `system/surfaces/cli/index.ts` — add `mcp extension` subcommand
- `system/lib/mcp-config/write.ts` — add `upsertProjectScopeMcp(projectDir, entry)` helper that writes `.mcp.json` in a project root

**Acceptance criteria:**
- `pnpm robin mcp extension` runs the server
- All 18 tools register successfully with the McpServer instance
- Action-dispatched tool schemas use `oneOf` discriminated unions correctly
- A test similar to `core/server.test.ts` confirms the server builds with no errors
- The architecture-invariant test `tests/architecture/mcp-surface.test.ts` (new) asserts both servers expose exactly the locked tool set

**Estimated:** 1-2 subagent tasks. Heavy in lines (lots of tool registrations) but mechanical.

**Dependency:** P0.2 (at least gmail + calendar) so dispatched tools have real handlers.

---

### P1.2 — Interactive `robin init`

**Why deferred:** `--yes` (non-interactive) ships. TTY prompts + OAuth + model pulling deferred until the underlying primitives are stable (they are now).

**Scope:** Make `robin init` (no `--yes`) interactive.

**Files to modify:**
- `system/surfaces/cli/init.ts` — when `--yes` not set, run an interactive flow with prompts
- Add a tiny prompt library (don't bring in `inquirer` for one screen — use `node:readline/promises`)

**Interactive flow steps:**
1. Detect hardware → show profile → ask "use detected profile or override?"
2. Choose brain-slot config: `A` (local-first via Ollama) / `B` (cloud-only DeepSeek + Groq + Claude Code) / `C` (manual edit later)
3. If A or B, prompt to pull/install models (offer commands; don't actually pull from inside init)
4. Show list of Tier-1 integrations; toggle which to enable
5. For each enabled integration, run `robin auth <integration>` (OAuth/secret entry) inline
6. Offer to register launchd (macOS) / systemd (Linux) service
7. Offer to write robin MCP entry to `~/.claude.json`
8. Print summary + next steps

**Files to create:**
- `system/surfaces/cli/init-interactive.ts` (separate from init.ts to keep --yes path lean)
- `system/surfaces/cli/auth/google.ts` — Google OAuth device-flow or refresh-token paste prompt
- `system/surfaces/cli/launchd.ts` — write the user-agent plist + `launchctl load` it

**Acceptance criteria:**
- `robin init` (no `--yes`) walks through all prompts on a fresh user-data
- Each prompt has a sensible default that ENTER accepts
- `--reconfigure=<section>` flag re-runs just that section (profile/models/integrations/launchd/secrets/policies/mcp)
- Cancelling mid-flow leaves the system in a sane state (anything written is committed; nothing partial)

**Estimated:** 2 subagent tasks. ~3-4 hours each.

---

### P1.3 — Hot-reload watcher for integrations

**Why deferred:** chokidar is in deps but never wired. Without it, editing `user-data/extensions/integrations/<x>/index.ts` requires daemon restart.

**Scope:** Daemon watches `user-data/extensions/integrations/`, `user-data/extensions/jobs/`, `user-data/extensions/triggers/` and reloads on change.

**Files to modify:**
- `system/kernel/runtime/daemon.ts` — start a chokidar watcher in `start()`, stop it in `stop()`
- `system/integrations/_runtime/loader.ts` — expose `reloadOne(name)` that drains in-flight ticks (30s cap), calls `cleanup()`, dynamic-imports fresh, calls `init()`

**Acceptance criteria:**
- Touching an integration's `index.ts` triggers a clean reload visible in `daemon.log` ("reloading integration X")
- Permission diff: if `integration.yaml` requests new permissions, reload is paused until `robin extensions grant <name>` is run
- Debounce 200ms after last fs event (per design doc §12)
- Test in `tests/integration/hot-reload.test.ts` — write integration → daemon picks it up → edit → daemon picks edit up

**Estimated:** 1 subagent task. ~2 hours.

---

### P1.4 — Biographer stage 3: LLM disambiguation

**Why deferred:** MVP biographer does stages 1 (exact match) + 2 (embedding match via `findEntity`). Stage 3 (LLM-driven disambiguation when entity is novel or ambiguous) deferred until structured-output discipline is proven over real workloads.

**Scope:** When biographer extracts an entity and `findEntity` returns multiple candidates (or none, but the name looks like a known type alias), call an LLM with the candidate list + the source context and ask "which is this, or is it new?"

**Files to modify:**
- `system/brain/cognition/biographer.ts` — add `disambiguate()` step between extraction and upsert
- Add a zod schema for disambiguation response: `{matched_id: number | null, create_new: boolean, reason: string}`

**Acceptance criteria:**
- When extracting "Kevin" and the entities table has both "Kevin Lee" and "Kevin Chen", the LLM disambiguates based on context
- When extracting "Sara" and "Sarah" already exists, the LLM either merges to Sarah's id or creates new based on context evidence
- Test with a mock LLM that returns specific responses; verify the right entity row gets the relation

**Estimated:** 1 subagent task. ~3 hours.

**Dependency:** P0.4 (real LLM validation) is helpful for tuning prompts.

---

### P1.5 — Daemon-unhealthy notification path

**Why deferred:** The `daemon.heartbeating` invariant exists but if the daemon goes unhealthy nothing notifies the user.

**Scope:** When invariants fire repeatedly with critical failures (or launchd restarts the daemon >N times in M minutes), send a notification via the `notify` integration if granted.

**Files to modify/create:**
- `system/integrations/builtin/notify/integration.yaml` (new) — declares macOS notify + optional discord/imessage write capabilities
- `system/integrations/builtin/notify/index.ts` (new) — exposes a `notify(channel, message)` callable to the daemon
- `system/kernel/runtime/health-monitor.ts` (new) — tracks restart count + invariant failure streaks; calls `notify` when thresholds cross

**Acceptance criteria:**
- 3 consecutive critical invariant failures → one `macos_notify` per failure type per hour (rate-limited)
- Daemon restart loop (>3 in 5 min) → one `macos_notify`
- All notifications also write `refusal`/`audit` rows so they're queryable

**Estimated:** 1 subagent task. ~2 hours.

---

## P2 — Polish / future

These don't block daily-driver use; design-doc Phase 2 items.

### P2.1 — Kuzu graph projection — DROPPED 2026-06-11

Scaffold removed. Kuzu upstream was archived Oct 2025 (fragmented forks, no clear successor), and the relations table (<10k edges, ~4.5k/month growth) is years from outgrowing SQLite traversal. Decision recorded in ARCHITECTURE.md §Database; revisit only if relations pass ~1M rows AND a maintained engine emerges AND a feature needs path-pattern queries.

### P2.2 — OpenTelemetry exporter

Stub at `system/lib/telemetry/otel.ts`. Connect to Honeycomb / Grafana Cloud free tiers for dashboards. ~1 task.

### P2.3 — APFS snapshots for `robin db backup`

Currently uses `wal_checkpoint(TRUNCATE)` + atomic file copy. APFS snapshots are faster + free but require permissions. Investigate non-sudo paths. ~1 task.

### P2.4 — DSPy prompt optimization (Python sidecar)

Layer 3 currently uses correction-replay few-shot retrieval. Real DSPy integration requires a Python sidecar; design-doc §6 calls for `B-lite` mode (single Python sidecar). ~3 tasks (sidecar lifecycle + IPC + DSPy harness).

### P2.5 — Multi-account integration support

Currently one instance per integration name. Multi-instance (`gmail-work` + `gmail-personal`) requires the loader to handle named variants and namespace them in `integration_state`. ~1 task.

### P2.6 — Battery threshold auto-pause + metered SSID detection

Only `on_low_power_mode` is wired. Battery percentage requires `pmset` polling or IOPSCopyPowerSourcesInfo. Metered-SSID requires user-tagged config since macOS doesn't expose metering reliably. ~1 task.

### P2.7 — Codex SDK adapter (optional)

When `openai/codex#15451` (`--output-schema` ignored with MCP tools) closes, add a Codex adapter at `system/brain/llm/codex.ts`. Until then, do not add — see design doc risks. Track upstream issue.

---

## Tooling / infrastructure

### T.1 — CI workflow (GitHub Actions)

**Why deferred:** Tests run locally fine. CI workflow files were spec'd in design §17 but not committed.

**Scope:** Create `.github/workflows/tests.yml`:
- On every push + PR: `pnpm install` → `pnpm typecheck` → `pnpm lint` → `pnpm test` → gitleaks → smoke
- Smoke: `ROBIN_USER_DATA_DIR=$(mktemp -d) pnpm robin init --yes && pnpm robin doctor --json | jq -e '.summary.exit_code == 0'`

**Estimated:** 0.5 task.

### T.2 — Docker image

Multi-arch (amd64 + arm64). `Dockerfile` + `.dockerignore`. Volume-mount `user-data/`. Documented in README under "Docker mode". ~1 task.

### T.3 — launchd plist generator

`robin init` should write `~/Library/LaunchAgents/com.robin.daemon.plist` (macOS) or `~/.config/systemd/user/robin.service` (Linux) and load it. ~1 task. Could fold into P1.2 interactive init.

### T.4 — `robin upgrade` migrations runner

`npx robin-assistant upgrade` should: detect new migrations, back up the DB to `.bak-<ts>`, apply migrations in a tx, restart the daemon. ~1 task.

### T.5 — `robin db backup / restore / vacuum` CLI verbs

These are listed in the spec but stubbed. Each is ~30 LOC. ~0.5 task total.

### T.6 — Companion repo template

`docs/companion-repo-template/` with a working `robin-personal/` skeleton: `user-data/` tree, age-encrypted secrets example, restic sync config. ~1 task.

### T.7 — README + contribution surface

Update `README.md` from the placeholder to a real Quick Start. Add `CONTRIBUTING.md`, `SECURITY.md`, `CODEOWNERS`. ~0.5 task.

---

## Items explicitly NOT planned

These are by design (do not pick up):

- **Tier 3 personal integrations** (whoop, ebird, letterboxd, lrc, nhl, lunch_money) — these live in your private `robin-personal` companion repo, NOT in the npm package
- **`gemini-cli` provider as load-bearing** — Google's actively restricting Gemini CLI's free-tier programmatic access (see design doc §21 risks). Keep as optional alternate only
- **Anthropic API direct adapter as default** — Claude Code subscription path is what we use; direct API was Phase 2 in design and is still Phase 2
- **Windows support** — tracked but not launch-blocking
- **Hosted SaaS / multi-tenant** — out of scope; single user per daemon

---

## How to pick the next item

1. Skim the priority bands top-down
2. Check the "Dependency" row — if it points to an unmet item, do that first
3. Read the matching section in `docs/specs/2026-05-18-robin-v3-design.md` for full context
4. Use the `subagent-driven-development` skill the same way the initial build did: implementer subagent → spec review → code review → mark complete
5. Update `docs/STATUS.md`'s "Known gaps" section when a backlog item ships

## Suggested next session opener for an agent

> "Read `docs/STATUS.md` and `docs/BACKLOG.md`. Then pick the highest-priority unblocked P0 item and execute it via the `subagent-driven-development` skill. After each item, update both STATUS.md and BACKLOG.md to reflect what shipped."
