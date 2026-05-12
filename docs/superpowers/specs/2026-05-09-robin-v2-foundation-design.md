# Robin v2 Foundation — Design

**Status:** Design (pre-implementation)
**Author:** Brainstorming session, 2026-05-09
**Targets:** A new SurrealDB-first rebuild of CLI Robin, published as `robin-assistant@6.0.0` (same npm name as v1; major-version breaking release).
**Scope:** Strategic framing for the full v2 effort + detailed design for Phase 1 (the foundation) + a preview of Phase 5 (the v1→v2 migration path).

---

## 1. Why v2 instead of finishing the v1 cutover

v1 is mid-cutover from a markdown-file memory layer to SurrealDB. The kevin-flagged DNA problems with v1, all four confirmed:

1. **Markdown is still the source of truth.** SurrealDB is behind a feature flag; if the daemon is down, file paths take over. The render-shim reconstructs markdown views from DB rather than the agent reading DB directly. SurrealDB feels like a cache, not the system of record.
2. **Data model is markdown-shaped.** Tables and queries mirror file/folder structure (`knowledge/<topic>/`, `journal`, `hot.md`) instead of being designed around graph edges, vector recall, time-series, and live queries that SurrealDB is good at.
3. **Codebase is full of dual-path branching.** Cutover/feature-flag code (`if (daemon.up) { db } else { fs }`) bleeds through the call sites — capture, recall, biographer, jobs, hooks. Architecturally hybrid, not DB-first.
4. **Agent/CLI surface still thinks in files.** Hooks, prompts, AGENTS.md, and rules reference paths like `user-data/memory/...`. Even with DB underneath, the assistant is conceptually a file-driven system.

Continuing the in-place cutover means fighting v1's 516 JS files, 30+ migrations, and feature flags at every step — while finding markdown-first leaks for months. v2 is a clean restart.

## 2. What Robin v2 is

### 2.1 Product paragraph (source of truth)

Every phase in section 3 builds toward this paragraph; nothing in v2 should violate it.

> **Robin v2 is a personal AI assistant backed by a multi-model SurrealDB instance — graph + vector + time-series + structured + full-text in one engine. The agent surface is MCP: Claude Code and Gemini CLI integrate via an MCP server that exposes Robin's capabilities (recall, capture, jobs, etc.) as native tools. Memory has two cooperating agents: a *biographer* that captures and routes signals in real time as live-query subscribers, and a *dream* agent that periodically consolidates short-term events into long-term knowledge — episodes, entities, edges, preferences. Robin schedules and executes jobs (cron-style + protocol-triggered). And Robin self-improves via two cooperating loops: a *heuristic loop* (explicit corrections and preferences captured as events → dream surfaces patterns → user-approved updates to DB-backed rules) and a *learning loop* (implicit feedback signals — which recall hits the agent actually used, which got cited, which were rejected — train a local reranker that improves recall quality over time). Heuristic loop is fast, transparent, auditable. Learning loop is slow, statistical, opaque. Both are needed.**

### 2.2 Self-improvement design (sketch — full design lands in Phase 4 spec)

Two cooperating loops. Both ship in Phase 4. Sketched here so Phase 1's data-shape decisions don't accidentally close doors.

**Heuristic loop (correction-driven, explicit):**
- User says "Robin, stop doing X" or "I prefer Y" or corrects a behavior.
- Biographer captures the correction as an `events` row with `meta.kind = 'correction'` (or `'preference'`).
- Dream's nightly pass: clusters corrections, applies a v1-style trigger threshold (3+ consistent signals, or explicit user directive, or repeat within 14 days), produces a *rule update candidate*.
- Candidate appears in a queue for user review. User approves → the rule lands in a DB-backed `rules` table that the agent reads at session start.
- Auditable: every rule has provenance (which corrections fed it, when applied, who approved).

**Learning loop (feedback-driven, implicit, ML-shaped):**
- **Feedback capture:** Every `recall()` invocation logs a `recall_event` row with the query, the returned hits + their HNSW dist scores, and (after the agent's response is complete) which hits got *used* — cited in the answer, drove a follow-up action, or were referenced verbatim. Used-or-not is the relevance signal.
- **Reranker model:** A lightweight gradient-boosted model (e.g., LightGBM via a JS port, or a small ONNX neural reranker) trained on `(query_embedding, hit_embedding, hit_features, dist) → used (binary)`. Hit features include: `source`, `recency_bucket`, `dist`, source-specific meta (e.g., is it a biographer episode vs a raw event), and graph-distance from any entities mentioned in the query.
- **Inference:** At recall time, post-HNSW top-K is reranked by the model. If the model is missing or its confidence is low, fall back to base HNSW order.
- **Training:** Periodic batch (e.g., weekly) re-train from accumulated `recall_event` rows. Stored as `~/.robin/models/reranker.bin` with a version row in `runtime:reranker`.
- **Knowledge-promotion classifier (secondary):** A separate model that predicts whether a short-term memory (event/episode) should graduate to long-term knowledge. Inputs: access frequency, recency-decay, biographer's tag distribution, user explicit signals. Output: promote / keep / archive. Dream consumes its predictions during the nightly pass.

**Explicitly out of scope for v2:**
- No embedder fine-tuning (slow, expensive, marginal gain for a single-user corpus).
- No local LLM fine-tuning / LoRA (heavy infrastructure; not a personal-assistant scope).
- No reinforcement learning (RLHF-style) — the reward signal is too noisy from one user.
- No federated or shared learning across Robin instances (privacy + scale concerns).

The Phase 1 schema does not need any reranker fields yet, but **events.meta is FLEXIBLE** so Phase 4 can add reranker training-feedback rows without a schema break. A separate `recall_event` table arrives in Phase 4.

### 2.3 Strategic decisions

**Form factor.** v2 is still a CLI/npm package in the Claude Code + Gemini CLI host model (hooks, jobs, host adapters, Discord bot all carry forward, redesigned). Cursor host is dropped. Web product (`askrobin.io`) is the CLI-in-VM and is unaffected.

**Agent integration: MCP.** Claude Code and Gemini CLI talk to Robin via an MCP server that exposes Robin's capabilities (recall, recordEvent, jobs control, etc.) as native MCP tools. Bash shell-out and hook-injected context are explicitly *not* the chosen interface — MCP is the committed long-term shape. Phase 1 still ships internal-only because the MCP server lifecycle + host wiring are Phase 3 scope; the internal `recall()` and `recordEvent()` functions are written with their MCP-tool signatures already in mind, so Phase 3 wraps rather than rewrites.

**Package and repo.**
- Local build location: `~/workspace/robin/robin-assistant-v2/` (new repo, fresh git history). The `-v2` suffix is a directory disambiguator only.
- npm name: `robin-assistant` — same as v1. v2 publishes over the existing npm name as a major-version breaking release.
- npm version at first publish: `6.0.0` (alphas leading up: `6.0.0-alpha.0`, etc.).
- bin name: `robin`.
- Existing `~/workspace/robin/robin-assistant/` directory stays as v5 (Kevin's daily Robin throughout the build). Frozen at cutover; archived on GitHub. v5 users who run `npm install -g robin-assistant` after v6 publish get the breaking upgrade — they have to opt out by pinning `5.x` if they want to stay.

**Data continuity.** Lossless migration from v1 to v2 is required. Every memory shape v1 has must be representable in v2 and importable via the Phase 5 migrator.

**Drop-list (cut from v2 scope):**
- Cursor host adapter / `robin-cursor` test instance.
- Watches subsystem (one unused watch in current data; small surface to drop now and rebuild fresh later if needed).

**Keep-list (carried forward, redesigned not lifted):**
- Claude Code + Gemini CLI host adapters.
- Discord bot.
- Publish-to-web flow (may need redesign now that askrobin.io is CLI-in-VM).
- All memory shapes: events, episodes, entities, edges, knowledge, journal, threads, hot, profile, patterns, biographer.
- Jobs runner, sync/integrations, hooks dispatcher.

## 3. Decomposition into phases

v2 is too large for a single spec. Each phase below gets its own brainstorm → spec → plan → implementation cycle. Phase 0 is the only exception (small enough to do tactically).

| # | Phase | Output |
|---|---|---|
| 0 | Drop-list locked (this doc) + lift decisions made in-context | Strategic constraints frozen |
| 1 | **Foundation: capture + recall vertical slice** (this doc) | Working internal `recordEvent` + `recall()` over SurrealDB; no agent interface yet. Phase 1 schema is `events` + `runtime` only; graph deferred. |
| 2 | Memory completeness — graph DB + biographer + dream | **Graph** (entities + edges, RELATE-based, with `REFERENCE`/`<~` back-refs where they fit). **Biographer** (live-query subscriber on `events`; routes captures into episodes/entities/edges/preferences in real time). **Dream** (periodic batch agent: consolidates episodes into long-term knowledge, prunes/promotes, surfaces self-improvement candidates). Knowledge graph, journal, threads, hot, patterns, profile all built on this layer. |
| 3 | Host integration + MCP agent surface | **`robin-mcp` server** exposing Robin's capabilities as native MCP tools (recall, recordEvent, listSources, jobs control, etc.). Wired into Claude Code (`mcpServers` in settings.json) and Gemini CLI equivalent. Hooks dispatcher + AGENTS.md/rules generator that reads DB. **Begin dogfooding** — daily-use Robin routes recall through v2 MCP while v1 still handles writes. |
| 4 | Daily-use parity + self-improvement | Jobs runner (cron + protocol-triggered), integrations sync, Discord, publish. **Both self-improvement loops** (per section 2.2): the **heuristic loop** (corrections/preferences → dream patterns → user-approved DB-backed rules) and the **learning loop** (feedback capture from recall use → trained reranker that post-HNSW reorders results, plus a knowledge-promotion classifier). |
| 5 | v1→v2 migrator + cutover | Lossless one-shot import; switch daily-use Robin to v2; freeze v1. |

**Build-order rationale.** The data model is co-designed with the first real workflow that uses it (Phase 1's capture+recall) rather than designed in isolation up front. Graph (entities + edges) lands in Phase 2 with the biographer that produces them — not Phase 1, where there'd be nothing to populate edges. Dream lands with biographer because dream consumes biographer's output. MCP lands in Phase 3 because that's when daily-use dogfooding starts and we need a real agent interface. Both self-improvement loops land in Phase 4 because they need the full memory stack (events → episodes → patterns → rules) AND accumulated recall-feedback signal to function. The migrator is built late deliberately — schema must stabilize first.

## 4. Phase 1 design — capture + recall vertical slice

### 4.1 The slice

Smallest end-to-end memory loop that proves all four DNA fixes:

1. **Write side: a single `recordEvent` primitive.** One function, one schema. Specific v1 capture surfaces (Stop-hook auto-memory, biographer auto-slice, manual notes, ingest, sync) are *not* in Phase 1 — they're Phase 2/3 wirings on top of `recordEvent`.
2. **Read side: `recall()` as an internal JS function** (vector similarity + recency window filter + simple filters; no entity graph, no rerank — those are Phase 2). **No CLI subcommand for recall in Phase 1.** Robin is never invoked directly by the user; the agent-facing interface (Bash CLI vs MCP server vs hook-injected context) is a Phase 3 design decision evaluated against real usage data, not pre-committed in Phase 1.
3. **Phase 1 manual smoke testing** uses a `scripts/dev-recall.js` ad-hoc query script — not part of the user-facing surface, not on the CLI.
4. **Schema migration tooling lands with Phase 1.** Versioned `.surql` migrations + a migration runner.
5. **Daemon/runtime state lives in DB**, not in JSON lock files. Sets the SurrealDB-first precedent for everything else.

**Phase 1 ships in isolation.** v1 remains daily-use Robin. v2 has no real users — no hooks, no Claude Code wiring, no migrator. First daily-use signal lands in Phase 3.

**Out of scope (deferred to Phase 2):** entity extraction, edges, graph traversal, biographer, episodes, reranker, all v1 capture-surface wirings, profile, knowledge, journal, hot, threads, patterns.

### 4.2 Repo, package, runtime shape

**Layout (flat, not monorepo):**

```
robin-assistant-v2/
  bin/                  # robin (the executable)
  scripts/
    dev-recall.js       # ad-hoc query helper for Phase 1 smoke testing
  src/
    cli/                # arg parsers + handlers (migrate, version, help)
    capture/            # recordEvent (internal)
    db/                 # SurrealDB lifecycle, client, migration runner
    schema/
      migrations/       # NNNN-name.surql files — source of truth
      types.ts | .d.ts  # hand-written types alongside schema (TS adoption TBD)
    embed/              # embedder lifecycle (transformers.js)
    recall/             # internal recall(query, opts) function
    runtime/            # data-home setup, runtime-table writes
  tests/
    unit/
    integration/
    fixtures/
  AGENTS.md             # placeholder in Phase 1; populated in Phase 3
  package.json          # name: robin-assistant, version: 6.0.0-alpha.0
  README.md
```

No monorepo, no pnpm, no Turbo. Single package. Split if a clean `@robin/core` boundary emerges later.

**Runtime:**
- **Embedded SurrealDB via `@surrealdb/node` v3** with `rocksdb://` engine (file-backed, mature). `mem://` for tests.
- **Embedder runs in-process** via `@xenova/transformers`, lazy-loaded on first use.
- **No long-running daemon in Phase 1.** Each `robin <cmd>` invocation boots, opens DB, runs, exits. Daemon model arrives in Phase 3 when hot-path Stop-hook latency matters.
- **Concurrency: cooperative file lock.** Embedded RocksDB is single-process (skill gotcha #10). Phase 1 takes a `flock(2)` on `~/.robin/.lock` at boot; concurrent invocations block until release (with a 30s timeout that errors with a clear message). Phase 1 has only `robin migrate` as a CLI command, so contention is rare — this is mostly defense against re-running migrate during a stuck process. Phase 3's daemon model supersedes the lock.
- **Backup: pre-migration tar of `~/.robin/db/`** runs automatically before any non-zero migration is applied. Lifted from v1's pattern. Stored in `~/.robin/backup/<timestamp>.tar`. No automatic prune in Phase 1 — manual cleanup; revisit retention policy in Phase 4.

**Tech stack:**
- Node ≥ 22, ES modules.
- No commander/yargs (3 commands warrant a hand-rolled parser).
- No build step. JavaScript with optional JSDoc types. **TS adoption is TBD for Phase 2**.
- Test runner: `node --test`.
- Lint: Biome.

**Data home: `~/.robin/`** (override via `ROBIN_HOME`).

```
~/.robin/
  db/         # RocksDB data files
  models/     # transformers.js model weight cache
  logs/       # reserved for Phase 3 daemon
```

### 4.3 Schema as source of truth

`.surql` files in `src/schema/migrations/NNNN-name.surql` are canonical. Hand-written TS/JS types alongside.

**Migration runner (~40 lines).** On boot, after `db.connect` + `db.use`:
- **Bootstrap check.** Read `INFO FOR DB` and check whether `_migrations` exists. If it doesn't, treat applied-set as empty (don't `SELECT FROM _migrations` — that errors in v3 on a non-existent table per skill gotcha #5). The first migration file (`0001-init.surql`) creates the table.
- For each `.surql` file in order: compute SHA256, compare against `_migrations.checksum` for that version.
- If applied: assert checksum matches; else error (forces a new migration file rather than silent drift).
- If not applied: BEGIN TRANSACTION; run the file; CREATE the `_migrations` row using the `surql` tagged template (parameterized — never string-interpolate filename/checksum); COMMIT.
- All filename/version/checksum values flow through `surql\`...${value}...\`` bindings — never raw concatenation.

`robin migrate` is the same code path, exposed as an explicit command for ops clarity.

**`0001-init.surql` — Phase 1 schema:**

```surql
DEFINE DATABASE main STRICT;

DEFINE TABLE _migrations SCHEMAFULL TYPE NORMAL;
DEFINE FIELD version    ON _migrations TYPE int;
DEFINE FIELD name       ON _migrations TYPE string;
DEFINE FIELD checksum   ON _migrations TYPE string;
DEFINE FIELD applied_at ON _migrations TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX _migrations_version ON _migrations FIELDS version UNIQUE;

DEFINE TABLE events SCHEMAFULL TYPE NORMAL;
DEFINE FIELD source       ON events TYPE string
  ASSERT $value IN ['cli', 'stop_hook', 'manual', 'sync', 'biographer', 'ingest', 'discord', 'migration'];
DEFINE FIELD content      ON events TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD content_hash ON events TYPE string;   -- sha256(content); top-level so it's indexable
DEFINE FIELD ts           ON events TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta         ON events TYPE option<object> FLEXIBLE;
DEFINE FIELD embedding    ON events TYPE array<float>
  ASSERT array::len($value) = 768;   -- TODO: pinned by embedder benchmark before Phase 1 ships
DEFINE INDEX events_ts      ON events FIELDS ts;
DEFINE INDEX events_source  ON events FIELDS source;
DEFINE INDEX events_chash   ON events FIELDS content_hash;   -- speeds embedder cache lookup
DEFINE INDEX events_vec     ON events FIELDS embedding
  HNSW DIMENSION 768 DIST COSINE TYPE F32 EFC 200 M 16;

DEFINE TABLE runtime SCHEMAFULL TYPE NORMAL;
DEFINE FIELD value      ON runtime TYPE object FLEXIBLE;
DEFINE FIELD updated_at ON runtime TYPE datetime VALUE time::now();
```

**Decisions justified:**
- `DEFINE DATABASE main STRICT` — refuses implicit table creation; SurrealDB v3 syntax replacing the v2 `--strict` flag.
- `SCHEMAFULL` everywhere — extras error in v3, catching typos at write-time.
- `events:ulid()` IDs (default) — time-sortable, no ID strategy needed at write sites.
- HNSW with EFC 200, M 16 — recommended starting point per the surrealdb skill for ~1M-vector AI memory.
- `source` as closed enum — adding a new source is a deliberate migration.
- `meta` as `option<object> FLEXIBLE` — escape hatch for source-specific extras and migration provenance.
- No entities table in Phase 1 — adding it later is a clean migration; including it now risks under-designed edges.

### 4.4 Embedder pipeline

**Interface (model-agnostic):**

```ts
export interface Embedder {
  readonly dimension: number;
  readonly modelId: string;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}
```

Lazy-loaded singleton (in-process via `@xenova/transformers`). Embedder state recorded in `runtime:embedder` (model id, loaded_at, dimension).

**No chunking in Phase 1.** Events are short by construction. Long-text chunking is the migrator's problem (Phase 5).

**Caching: content-keyed.** `embed()` checks `events.content_hash = sha256(text)` (top-level indexed field) first; reuses the existing embedding on hit. Saves cost on migrator re-imports and near-duplicates.

**Failure modes:**
- Model load fails → write/recall both error loudly. No "no embedding" silent fallback.
- OOM on `embedBatch` → batches auto-shrink (256 → 128 → 64) until they fit.

### 4.5 Embedder benchmark (resolves the schema's 768 TODO)

**Inputs:**
- Corpus: ~5k events exported from v1 (recent journal + knowledge slice + biographer slices).
- Queries: 50–100 with relevance labels. Half hand-written; half synthesized by taking biographer slices' first sentence as query and the rest as gold-relevant.

**Candidate models:**

| Model | Dim |
|---|---|
| `Xenova/bge-small-en-v1.5` | 384 |
| `Xenova/bge-base-en-v1.5` | 768 |
| `Xenova/bge-large-en-v1.5` | 1024 |
| `Xenova/all-MiniLM-L6-v2` | 384 |

**Metrics:** NDCG@5, NDCG@10, MRR, p50/p95 single-query inference latency on Apple Silicon.

**Decision rule:** Highest NDCG@5, *unless* a smaller/faster model is within 2 points — pick the faster one (latency matters because Stop-hook captures will block on `embed()` in Phase 3).

**Output:** `docs/superpowers/specs/2026-05-09-robin-v2-embedder-benchmark.md` with the table and chosen model. Then a migration `0002-pin-embedding-dim.surql` re-creates the HNSW index at the chosen dimension and tightens the assert.

### 4.6 Recall pipeline (internal API only)

**No CLI subcommand in Phase 1.** Recall is exposed only as a JS function. The agent-facing interface (Bash CLI vs MCP server vs hook-injected context) is decided in Phase 3 against real usage data.

**Internal API:**

```ts
// src/recall/index.ts
export interface RecallOptions {
  limit?: number;          // default 10
  source?: EventSource;    // filter to one capture source
  since?: Date | string;   // exclusive lower bound on ts
  until?: Date | string;   // exclusive upper bound on ts
  explain?: boolean;       // attach EXPLAIN FULL output to the result
}

export interface RecallResult {
  hits: Array<{
    id: RecordId;
    source: EventSource;
    content: string;
    ts: Date;
    meta?: Record<string, unknown>;
    dist: number;
  }>;
  explain?: string;        // populated when opts.explain === true
}

export async function recall(query: string, opts?: RecallOptions): Promise<RecallResult>;
```

**Flow:**
1. `embed(query)` → `Float32Array`.
2. Run parameterized SurrealQL:

```surql
SELECT
  id, source, content, ts, meta,
  vector::distance::knn() AS dist
FROM events
WHERE
  embedding <|$limit, 64|> $qvec
  AND ($source IS NONE OR source = $source)
  AND ($since IS NONE OR ts > $since)
  AND ($until IS NONE OR ts < $until)
ORDER BY dist
LIMIT $limit;
```

3. Optionally run `EXPLAIN FULL` for the same query and attach.
4. Return structured result.

**Recency in Phase 1: filter only, no rank fusion.** A weighted blend lands later if the benchmark or daily use shows recall is recency-blind.

**Manual smoke testing during Phase 1 dev** uses `scripts/dev-recall.js` — a ~20-line script that imports `recall()` and prints results. Not on the CLI, not advertised to users. Deleted or kept as `scripts/` ergonomics depending on Phase 3's interface choice.

**`opts.explain`** captures the planner's `EXPLAIN FULL` output for the recall query so we can verify HNSW index use (per surrealdb skill gotcha #3 — HNSW operator doesn't *guarantee* index use; the planner decides).

### 4.7 CLI surface

Robin is not user-facing. The user only interacts via Claude Code or Gemini CLI; the agent invokes Robin (in Phase 3+, via mechanisms decided then). Phase 1 ships the **minimum CLI needed for ops** — bootstrap, schema, sanity:

```
robin migrate                  # run pending schema migrations (also runs implicitly at boot)
robin --version | -v
robin --help    | -h
```

That's all. No `recall`, no `init`, no `capture`, no `db`, no `status`. First invocation auto-bootstraps `~/.robin/`.

**Internal APIs (not on the CLI, no public exports until Phase 3 picks the agent interface):**

```ts
// src/capture/index.ts
export async function recordEvent(input: {
  source: 'cli' | 'stop_hook' | 'manual' | 'sync' | 'biographer' | 'ingest' | 'discord' | 'migration';
  content: string;
  ts?: Date;
  meta?: Record<string, unknown>;
}): Promise<{ id: RecordId }>;

// src/recall/index.ts (signature in section 4.6)
export async function recall(query: string, opts?: RecallOptions): Promise<RecallResult>;
```

Phase 1 callers: tests, `scripts/dev-recall.js` (manual smoke), the migrator (Phase 5). Phase 3 caller: the `robin-mcp` server (committed agent interface) — exposes these functions as native MCP tools, wraps rather than replaces. Signatures are written with that wrapping in mind: structured args + structured returns, no flag parsing, no text-formatted output, errors as typed thrown values rather than stderr text.

### 4.8 Tests, CI, and the "Phase 1 done" checklist

**Test layout:**

```
tests/
  unit/
    embed.test.js              # cache hit path, batch shrink-on-OOM, dim assertion
    schema-migrator.test.js    # idempotent re-run, checksum mismatch error, transactional apply
    cli-args.test.js
  integration/
    recall-quality.test.js     # NDCG@5 ≥ 0.85 against seeded fixtures
    schema-asserts.test.js     # bad dim, missing fields, bad source enum all error
    explain-uses-knn.test.js   # asserts EXPLAIN FULL says Iterator: Knn
  fixtures/
    synthetic-events.json      # 200 events × 5 topic clusters
    seed-recall-pairs.json
```

Each integration test gets a fresh `mem://` SurrealDB instance per file.

**CI: GitHub Actions:**
1. Unit + integration on `node --test`, ubuntu-latest + macos-latest. (macOS catches `@surrealdb/node` prebuild gaps.)
2. Lint (`biome check`).
3. Schema lint: every `.surql` file parses against a `mem://` engine.

**"Phase 1 done" checklist:**

- [ ] Repo `~/workspace/robin/robin-assistant-v2/` exists, fresh git history, `package.json` says `robin-assistant@6.0.0-alpha.0`.
- [ ] Internal `recall("...")` works against an empty DB (returns empty hits, no error).
- [ ] Internal `recall("...")` works against the seeded fixture set with NDCG@5 ≥ T (proven by `tests/integration/recall-quality.test.js`). **T is set by the benchmark in 4.5** — likely ~0.85 for synthetic clusters but pinned by the actual chosen-model result, not pre-committed here.
- [ ] Schema migration runner: idempotent re-run, checksum mismatch error, transactional apply all proven by tests.
- [ ] Embedder benchmark spec written; chosen model committed; schema dimension pinned (no TODO).
- [ ] `EXPLAIN FULL` proves the recall query uses HNSW (asserted in CI).
- [ ] `~/.robin/` bootstrap from clean state works on macOS + Linux.
- [ ] CI green on both platforms.
- [ ] `scripts/dev-recall.js` runs end-to-end against a real `~/.robin/` for manual smoke.
- [ ] `AGENTS.md` exists as a placeholder noting Phase 3 will populate it (no agent integration yet — Phase 1 ships in isolation).
- [ ] CHANGELOG entry for `6.0.0-alpha.0`.

## 5. Phase 5 preview — v1 → v2 migration path

**Built late on purpose.** Schema must stabilize first or we'll keep redoing the migrator. Sketch only here; full design lands as Phase 5's own spec when Phase 4 completes daily-use parity.

**Tool:** `robin migrate-from-v1 --source ~/workspace/robin/robin-assistant`. Single CLI, run once.

**Inputs:**

| v1 location | Maps to v2 as |
|---|---|
| `user-data/memory/streams/{inbox,journal/log,log}.md` | `events` rows, `source = 'migration'`, `meta.kind = 'stream'`, `ts` parsed from line prefix |
| `user-data/memory/knowledge/<topic>/*.md` | `events` rows, `meta = { kind: 'knowledge', topic, file }`. Topics become `entities` in Phase 2 |
| `user-data/memory/journal/*.md` | `events` rows, `meta.kind = 'journal'`, `ts` from filename |
| `user-data/memory/{hot.md,threads/*.md,patterns/*.md}` | `events` rows, `meta.kind` per directory; v2 hot/threads/patterns get re-derived in Phase 2 |
| `user-data/profile/*.md` | Singleton `runtime:profile` row (Phase 1) or future `profile` table (Phase 2) |
| `user-data/integrations/*` cache | `events` rows, `source = 'sync'`, `meta.integration = '<name>'` |
| `user-data/runtime/state/*.json` | `runtime:<key>` rows (durable state only — job last-run timestamps, not transient locks) |
| **v1.5 SurrealDB tables** | Direct row-to-row export/import where shapes match; transform where they don't |

**Required properties:**
1. **Idempotent** — `meta.source_hash = sha256(file_path + line_or_chunk)` dedupes against existing rows.
2. **Resumable** — transactional batches; crash leaves at most one batch un-applied; `_migration_progress:v1_to_v2` tracks position.
3. **Auditable** — every migrated event keeps `meta.from_v1 = { path, line_range, migrated_at, source_hash }`.
4. **Embedding pass is separate** — markdown → events first (cheap, deterministic); embeddings in a follow-up pass that's throttle-able and resumable.
5. **Dry-run first** — `--dry-run` prints row counts per source, projected DB size, estimated embedding cost. No writes.
6. **Reversible only by recreating v2** — drop the v2 DB file and re-run; cleaner than partial-rollback logic.

**Not migrated:**
- Hooks state (rebuilt at first v2 boot).
- Locks/heartbeats (transient).
- Watches (dropped feature).
- Test instances (`robin-cursor`, `robin-gemini`).

**Cutover-day order:**
1. Stop v1 daemon, run a final v1 backup tar.
2. `robin migrate-from-v1 --dry-run` → review.
3. `robin migrate-from-v1` → real import. Embeddings pass runs in background and may take hours for ~50k events; capture/recall is *partially* available immediately (events without embeddings yet are excluded from vector recall but still queryable by source/time).
4. **During migration, daily-use Robin is degraded but not gone.** v1 is stopped; v2 has progressively more recall fidelity as the embedding pass proceeds. Plan cutover for an evening or weekend window. Worst case: pause cutover, re-start v1 from the pre-cutover backup, retry later.
5. Spot-check: a few `recall()` queries via the Phase 3 agent interface, compare to v1 grep results.
6. Switch `~/.claude/settings.json` hook paths from v1 to v2.
7. v1 directory stays on disk (gitignored) for grace; archive on GitHub at v6.0.0 publish.

## 6. Open questions / TBDs

| Question | Resolves in |
|---|---|
| Embedder model + final embedding dimension | Phase 1 benchmark (4.5) |
| TypeScript or JavaScript-with-JSDoc | Phase 2 (revisit when surface grows) |
| MCP server lifecycle (launchd vs in-process vs separate daemon binary) | Phase 3 — interface itself is committed (MCP); only the lifecycle/supervisor model is open |
| Daemon model design (single Node process vs spawn-per-command, MCP server as the long-running process) | Phase 3 (likely the MCP server *is* the daemon) |
| How `AGENTS.md` is generated (template vs DB-driven) | Phase 3 |
| Reranker / recency-aware ranking | Phase 2 if benchmark or dogfooding shows pure semantic ranking is recency-blind |
| Web product (`askrobin.io`) integration with v2 | Out of scope; CLI-in-VM design decoupled |
| Encryption at rest for `~/.robin/db/` | Phase 4 (RocksDB has no built-in encryption; consider a FUSE/filesystem layer or accept plaintext-on-disk for a single-user local install) |
| Backup retention policy (auto-prune `~/.robin/backup/`) | Phase 4 — Phase 1 keeps all pre-migration tars |
| 5.x maintenance after v6.0.0 publishes | Open — likely "5.x is frozen; critical bugs only via a `v5-maintenance` branch" |
| `events` deletion / forget semantics (privacy) | Phase 2 — events are append-only in Phase 1; soft-delete or retraction-record design lands later |
| Reranker model architecture (LightGBM-JS vs ONNX neural net vs other) | Phase 4 — depends on accumulated feedback volume and JS-runtime constraints |
| Reranker training cadence (nightly vs weekly vs on-N-new-feedback) | Phase 4 |
| Knowledge-promotion classifier features + threshold | Phase 4 |
| Where reranker model files live (`~/.robin/models/`) and versioning scheme | Phase 4 |

## 7. Next steps

1. User reviews this spec. Edits land via re-spec, not addenda.
2. On approval, hand off to `superpowers:writing-plans` for the Phase 1 implementation plan.
3. Plan covers concrete file-by-file build order, test-first sequencing, the embedder benchmark execution, and the path to satisfying the "Phase 1 done" checklist.
4. Phases 2–5 each get their own brainstorm → spec → plan cycle when the prior phase completes.
