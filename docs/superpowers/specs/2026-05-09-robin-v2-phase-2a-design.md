# Robin v2 Phase 2a — Graph + Biographer Design

**Status:** Design (pre-implementation)
**Author:** Brainstorming session, 2026-05-09
**Targets:** `robin-assistant-v2/` (the Phase 1 foundation). Builds the graph layer + biographer pipeline.
**Scope:** Phase 2a of the v2 plan — narrower than the foundation spec's Phase 2. MCP server is the immediate follow-on (Phase 2b). Dream, knowledge graph, journal, threads, hot, patterns, profile defer further (2c). Integrations defer to 2d.

**Phase decomposition (updated from foundation spec):**

| Sub-phase | Scope |
|---|---|
| **2a (this spec)** | Graph + biographer + multi-host adapters (Claude Code + Gemini, both with `invokeLLM` and prompt caching) |
| **2b** | MCP server + first tools (recall, recordEvent, biographer.trigger, entities.search) |
| **2c** | Dream agent + memory shapes (knowledge, journal, threads, hot, patterns, profile) |
| **2d** | Integrations (Gmail, Discord, etc. — `source: 'sync'` capture pipeline) |

Spec context: see `2026-05-09-robin-v2-foundation-design.md` for the v2 vision and broader phase plan.

---

## 1. Why Phase 2a is its own spec

The foundation spec's Phase 2 ("memory completeness") is too large for a single implementation plan: graph + biographer + dream + 7 memory shapes. This sub-spec narrows to **graph + biographer only**, in the same brainstorm → spec → plan cycle as Phase 1. Sub-phases 2b (dream + knowledge + memory shapes) and 2c (integrations) follow as their own cycles.

## 2. What gets built in Phase 2a

A SurrealDB-native graph layer with biographer extraction:

- **Entities table** with HNSW embedding index (5 entity types: person/place/project/topic/thing).
- **Edge tables** via `RELATE` (6 edge types: mentions/about/precedes/works_on/participates_in/co_occurs_with).
- **Episodes table** + record-link from events.
- **Biographer pipeline**: invoked via Stop hook + a CLI catchup command. One LLM call per event extracts entities + edges + episode-continuation signal. Cascade entity resolution (Stages 1+2+3).
- **Multi-host adapters** with `invokeLLM(messages, opts)`: Claude Code (lifted from v1) AND Gemini (committed; verification spike at start of plan determines whether to lift Gemini-CLI subprocess pattern OR build a direct Google API client). Both honor unified `opts.cache_control` and translate to provider-specific caching.
- **`events.biographed_at` field** for dedupe + migrator compatibility.

### Strategic decisions locked in this brainstorm

| Decision | Choice | Rationale |
|---|---|---|
| Phase 2 slice | 2a = graph + biographer only | Each sub-phase ~Phase-1-sized; tighter feedback loop |
| Biographer output | Entities + Edges + Episodes | Bundle in single LLM call; constrained vocabulary |
| LLM client | Host subprocess `invokeLLM` | Multi-model via host (Claude Code → Claude, Gemini CLI → Gemini); no API keys |
| Entity resolution | Full cascade (1: exact, 2: embedding, 3: LLM disambig) | User-chosen; quality up front, threshold tuning in 2b |
| Episode clustering | Hybrid time-window + LLM override | Best-quality boundaries with deterministic fallback |

### What's NOT in 2a (deferred)

- **MCP server + agent-facing tools** → 2b (immediate follow-on; not a long defer)
- Dream agent → 2c
- Knowledge graph, journal, threads, hot, patterns, profile → 2c
- Self-improvement loops → Phase 4
- Integrations (Gmail, Discord, etc.) → 2d
- Always-on biographer daemon → Phase 3+ if the fire-and-forget pattern proves insufficient
- Real-data threshold tuning for cascade Stage 2/3 → ongoing in 2c
- Topic-aware episode boundary refinement → 2c
- Aliases / nickname tables → 2c
- Re-biographing already-processed events (after vocab expansion) → 2c

## 3. Schema additions

New migration `0003-graph-biographer.surql` (runs after Phase 1's 0001 + 0002).

### `events` extensions

```surql
DEFINE FIELD biographed_at ON events TYPE option<datetime>;
DEFINE FIELD episode_id    ON events TYPE option<record<episodes>>;
DEFINE INDEX events_biographed ON events FIELDS biographed_at;
DEFINE INDEX events_episode    ON events FIELDS episode_id;
```

`episode_id` is a record link (1:N — event has 0 or 1 episodes). No separate edge table.

### `entities` table

```surql
DEFINE TABLE entities SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name        ON entities TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD name_lower  ON entities TYPE string VALUE string::lowercase(name) READONLY;  -- VALUE not COMPUTED: COMPUTED fields can't be indexed in v3
DEFINE FIELD type        ON entities TYPE string
  ASSERT $value IN ['person', 'place', 'project', 'topic', 'thing'];
DEFINE FIELD embedding   ON entities TYPE array<float>
  ASSERT array::len($value) = 384;
DEFINE FIELD created_at  ON entities TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta        ON entities TYPE option<object> FLEXIBLE;

DEFINE INDEX entities_name_lower ON entities FIELDS name_lower, type;
DEFINE INDEX entities_vec        ON entities FIELDS embedding
  HNSW DIMENSION 384 DIST COSINE TYPE F32 EFC 200 M 16;
```

`name_lower` is `COMPUTED` (materialized expression) — Stage 1 lookup is `WHERE name_lower = $lower AND type = $t`. Entity embedding is computed from `<type>: <name>` using the existing embedder.

### `episodes` table

```surql
DEFINE TABLE episodes SCHEMAFULL TYPE NORMAL;
DEFINE FIELD started_at  ON episodes TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD ended_at    ON episodes TYPE option<datetime>;
DEFINE FIELD source      ON episodes TYPE string;
DEFINE FIELD summary     ON episodes TYPE option<string>;
DEFINE FIELD meta        ON episodes TYPE option<object> FLEXIBLE;
DEFINE INDEX episodes_started ON episodes FIELDS started_at;
DEFINE INDEX episodes_source  ON episodes FIELDS source;
DEFINE INDEX episodes_active  ON episodes FIELDS source, ended_at;
```

**Lifecycle:** `ended_at IS NONE` means active. Episode ends when (a) biographer's LLM returns `episode_continues_previous: false` for the next same-source event, OR (b) time since the last event in the episode exceeds 30 minutes (whichever is first). On end, biographer sets `ended_at = <last event ts>` and may set `summary`.

### Edge tables

```surql
DEFINE TABLE mentions       SCHEMAFULL TYPE RELATION FROM events TO entities   ENFORCED;
DEFINE FIELD weight  ON mentions TYPE option<float>;
DEFINE FIELD context ON mentions TYPE option<string>;

DEFINE TABLE about          SCHEMAFULL TYPE RELATION FROM events TO entities   ENFORCED;
DEFINE TABLE precedes       SCHEMAFULL TYPE RELATION FROM events TO events     ENFORCED;
DEFINE TABLE works_on       SCHEMAFULL TYPE RELATION FROM entities TO entities ENFORCED;
DEFINE TABLE participates_in SCHEMAFULL TYPE RELATION FROM entities TO entities ENFORCED;

DEFINE TABLE co_occurs_with SCHEMAFULL TYPE RELATION FROM entities TO entities ENFORCED;
DEFINE FIELD strength  ON co_occurs_with TYPE float DEFAULT 1.0;
DEFINE FIELD last_seen ON co_occurs_with TYPE datetime DEFAULT time::now();
```

All edge tables are `ENFORCED` — referential integrity prevents dangling edges. Biographer must create entities before creating edges to them within a single transaction.

**`co_occurs_with` write pattern (per pair, both directions):**

```surql
LET $pair = string::concat($a.id().key, '|', $b.id().key);
LET $eid_ab = type::record('co_occurs_with', $pair);
UPSERT $eid_ab SET in = $a, out = $b, strength = (strength ?? 0) + 1, last_seen = time::now();
-- and the reverse
LET $eid_ba = type::record('co_occurs_with', string::concat($b.id().key, '|', $a.id().key));
UPSERT $eid_ba SET in = $b, out = $a, strength = (strength ?? 0) + 1, last_seen = time::now();
```

Stable IDs make UPSERT idempotent. **Cap N: top 8 most-confident entities co-occur per event** — keeps write amplification bounded (≤ 8×7 = 56 edge UPSERTs).

### `runtime` additions

```
runtime:biographer
  value = {
    last_processed_event_id: events:...,
    failed_event_ids: [events:..., events:...],
    last_run_at: datetime,
    entity_catalog_version: int,
    config: {
      stage2_high_threshold: 0.92,
      stage2_low_threshold: 0.80,
      episode_window_minutes: 30,
      catalog_size: 100,
      cooccur_cap: 8,
    },
  }

runtime:host
  value = {
    name: 'claude_code' | 'gemini_cli' | 'gemini_api',
    detected_at: datetime,
    invokeLLM_supported: bool,                  // false only when neither host's CLI is on PATH AND no GEMINI_API_KEY
    gemini_cache_id: string | null,             // current Gemini cachedContent resource ID
    gemini_cache_version: int | null,           // entity_catalog_version snapshot for the current cache
  }
```

Bootstrap: first-run biographer creates `runtime:biographer` with default config if absent. `entity_catalog_version` increments on entity create or merge; used as part of the prompt-cache key.

## 4. Biographer pipeline

```
biographer.process(eventId, db, host)
  1. Read event; skip if biographed_at IS NOT NONE.
  2. Build LLM context:
     - System prompt (cached, ~500 tokens): instructions, vocabulary, output JSON schema.
     - Recent-entities catalog (cached, ~1500-3000 tokens): top 100 entities by recency, type-grouped.
     - Active episode context (uncached, ~200 tokens): current open episode for this source.
     - Event content + meta.
  3. host.invokeLLM(messages, opts) → JSON output:
     {
       entities: [{ name, type }, ...],
       edges:    [{ from, type, to }, ...],
       about:    [name, ...],
       episode_continues_previous: bool,
       episode_summary: string | null,
     }
  4. Begin transaction.
  5. For each entity: cascade resolve (Stage 1 → 2 → 3); create new if all miss.
  6. Episode determination:
     - Find current-open episode for source.
     - If exists AND LLM says continue AND time-gap ≤ 30 min: extend.
     - Else: close current (ended_at, summary), CREATE new, link event.
  7. Write graph:
     - mentions edges (event → entity, with weight + context)
     - about edges (event → entity for "primarily about" entities)
     - typed edges from LLM output (entity → entity)
     - co_occurs_with for each entity pair (capped at top 8)
     - precedes edge if prior event in same source AND not same episode
  8. UPDATE event SET biographed_at = time::now(), episode_id = <episode>.
  9. Commit transaction.
  10. Update runtime:biographer (last_processed_event_id, increment entity_catalog_version if catalog grew).
```

### Cascade entity resolution

| Stage | Logic | When it fires |
|---|---|---|
| **1: exact** | `SELECT id FROM entities WHERE name_lower = $lower AND type = $t` | Always first |
| **2: embedding** | Compute embedding of `<type>: <name>`, HNSW lookup. Best ≥ 0.92 → resolve. ≥ 0.80 but < 0.92 → collect candidates for Stage 3. < 0.80 → no match. | Stage 1 misses |
| **3: LLM disambig** | `host.invokeLLM` with mention + top 3 candidates → pick existing or "none" | Stage 2 has candidates but none ≥ 0.92 |

Stage 3's LLM call is a separate, smaller invocation. Caches its disambiguation prompt at runtime.

### Failure handling

- **invokeLLM fails:** retry 3× with exponential backoff (1s, 2s, 4s). On terminal failure: log to `runtime:biographer.failed_event_ids`, leave `biographed_at = NULL`, return error.
- **Malformed JSON:** validate against schema. Schema fail → terminal failure (log + skip). No salvage attempts.
- **Stage 3 LLM fails:** fall back to "create new entity" with a warning in `event.meta.biographer_warnings`.
- **Cascade conflicts:** create new entity. Dream's merge pass (2b) handles dedup.
- **Race / TOCTOU:** dedupe via `biographed_at` re-check at transaction commit; second instance retries Step 1 and exits cleanly.

### Triggers

Biographer **never blocks the agent**. The Stop hook spawns a detached background subprocess and returns immediately.

1. **Stop hook (fire-and-forget)**: hook handler runs:

   ```js
   import { spawn } from 'node:child_process';
   import { open } from 'node:fs/promises';
   import { paths } from '../runtime/home.js';
   import { resolveBinPath } from '../runtime/bin.js';  // returns absolute path to bin/robin

   const logFh = await open(`${paths().logs}/biographer.log`, 'a');
   spawn(process.execPath, [resolveBinPath(), 'biographer', 'process-pending', '--since', lastStop], {
     detached: true,
     stdio: ['ignore', logFh.fd, logFh.fd],
   }).unref();
   ```

   Hook returns immediately (sub-millisecond). The detached subprocess runs biographer; if it crashes or takes minutes, the agent is unaffected. **stderr + stdout redirect to `~/.robin/logs/biographer.log`** so failures are debuggable post-hoc. **`process.execPath` + resolved bin path** instead of bare `'robin'` ensures it works in both global-install and dev-checkout setups.

   Two consecutive Stops can launch overlapping background processes — concurrency is handled by the file lock + `biographed_at` dedupe (the second process sees in-progress events as already-claimed at transaction commit).

   **Platform scope:** detached subprocess + `unref()` is POSIX-tested; Windows behavior is out of scope for 2a (matches Phase 1's ubuntu+macos CI matrix). Windows support lands in a future phase if/when needed.

2. **`robin biographer-catchup` CLI**: manual foreground invocation. Considers ALL events with `biographed_at IS NONE`. `--retry-failed` revisits `failed_event_ids`. Used after long offline periods, after the v1→v2 migration, or as a safety net.

No periodic cron / launchd job in 2a — that's Phase 4.

### Prompt caching (multi-host)

Three cacheable prompt layers:

| Layer | Tokens | Cache TTL | Invalidation |
|---|---|---|---|
| System prompt | ~500 | >1h (or longest TTL the host supports) | Biographer code change |
| Entity catalog | ~1500–3000 | ~5min | `entity_catalog_version` increments |
| Active episode context | ~200 | not cached | Volatile per call |

`opts.cache_control` is the unified abstraction. Each host adapter translates to provider-native caching:

- **Claude Code (Anthropic)**: `cache_control: { type: 'ephemeral' }` annotations on the appropriate message blocks. Cached input ~10% of uncached cost.
- **Gemini**: Google's caching API uses `cachedContent` resources (created via REST, referenced by ID in subsequent calls).
  - **Cache lifecycle:** adapter creates `cachedContent` keyed by `entity_catalog_version`. The cache ID is stored in `runtime:host.value.gemini_cache_id`. Reused until `entity_catalog_version` increments, at which point the adapter creates a new cache and **deletes the previous one** (DELETE call) to avoid Google-side accumulation.
  - **Garbage collection:** on adapter init, also list+delete any orphaned `cachedContent` resources older than 24h that don't match the current cache ID — defensive cleanup against crashed adapters that leaked caches.
  - **Minimum-size caveat:** Google's `cachedContent` requires a token-count floor (varies by model; e.g., 4096 tokens for Gemini Pro). The system prompt alone (~500 tokens) won't qualify; the entity catalog (~1500–3000 tokens) may not always qualify either. **The adapter only creates a cache when the cacheable layer total exceeds the model's floor; below it, calls go uncached.** This means Gemini caching coverage is partial — small entity catalogs miss caching entirely. Cost analysis assumes ~70% cache eligibility on Gemini vs ~95% on Anthropic.

If the verification spike shows Gemini CLI's subprocess interface doesn't expose caching primitives, the Gemini adapter falls back to direct Google API calls (still part of 2a, just a slightly different code path inside the adapter — the public `invokeLLM` interface stays uniform).

With caching, biographer cost drops from ~$0.004/event uncached to ~$0.001–0.002/event cached on either provider.

## 5. Host adapter (`invokeLLM`) subset

Phase 2a builds the host adapter slice that biographer needs (`invokeLLM` + detection). Phase 2b's MCP server reuses the same adapters; full host-integration polish (AGENTS.md generator, hooks dispatcher, dogfooding cutover) stays in Phase 3.

```js
// src/hosts/interface.js
/**
 * @typedef HostAdapter
 * @property {string} name
 * @property {() => Promise<boolean>} isAvailable
 * @property {(messages, opts) => Promise<{ content: string, usage }>} invokeLLM
 */
```

### Implementations (both shipped in 2a)

- **`src/hosts/claude-code.js`** — lifts v1's `feat(host): claude-code invokeLLM via subprocess`. Spawns `claude` CLI; sends wrapped prompt requesting JSON; parses stdout. Honors `opts.tier` for model selection (fast/balanced/deep) and translates `opts.cache_control` to Anthropic `cache_control: ephemeral` annotations.
- **`src/hosts/gemini.js`** — **committed for 2a**. Verification spike at start of plan determines mechanism:
  - **Path A (preferred):** Gemini CLI exposes a subprocess `invokeLLM`-equivalent → lift that pattern. **No API key required**; uses Gemini CLI's existing auth.
  - **Path B (fallback):** Direct Google Generative Language API client. **Requires `GEMINI_API_KEY` env var.** This is a meaningful asymmetry vs Claude Code (which uses host auth, no API key). User must obtain and configure a key; Gemini-via-Path-B is per-token billed against Google AI Studio. Setup docs must call this out clearly.
  - Implementation: HTTPS POST via Node's built-in `fetch` to `generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`, retry on 429, JSON parsing, mapping to unified `{ content, usage }`. Caching via Google's `cachedContent` resources (REST API; see caching subsection for GC strategy + minimum-size caveat).
  - Both paths share the unified `HostAdapter` interface — choosing Path B doesn't leak into the rest of v2.
- **`src/hosts/detect.js`** — host detection: env vars (`CLAUDE_PROJECT_DIR`, `GEMINI_*`), parent process command, marker files (`.claude/`). Cache result in `runtime:host`. Default to Claude Code on ambiguity. If user prefers Gemini they can set `ROBIN_HOST=gemini_cli` env var to force.

### Why this slice

- **Just enough for biographer.** Stage 3 disambiguation and main extraction both go through `invokeLLM`.
- **Phase 2b's MCP server wraps the same `invokeLLM`** — adapter code outlives 2a.
- **One small new dependency at most:** if Path B is needed, a tiny Google API HTTPS client (~50 lines using Node's built-in `fetch`). No SDK.

## 6. Tests + done checklist

### Test layout

```
tests/
  unit/
    cascade-stage1.test.js
    cascade-stage2.test.js
    cascade-stage3.test.js
    episode-clustering.test.js
    biographer-prompt.test.js
    host-detect.test.js
  integration/
    biographer-pipeline.test.js
    biographer-dedupe.test.js
    biographer-failure.test.js
    cascade-end-to-end.test.js
    schema-graph.test.js
```

Integration tests use a fake `invokeLLM` (no real CLI subprocess) for determinism + speed. A separate manual smoke test exercises the real Claude Code subprocess.

### "Phase 2a done" checklist

- [ ] Migration `0003-graph-biographer.surql` applies cleanly, idempotent re-run is no-op.
- [ ] `runtime:biographer` row created with sensible defaults on first run.
- [ ] Cascade resolution: each stage tested in isolation + end-to-end.
- [ ] Episode clustering: 30-min window respected; LLM override changes outcome.
- [ ] Biographer pipeline: process N synthetic events with fake `invokeLLM`, assert N entities + ≥N edges + ≥1 episodes + all events have `biographed_at` + correct `episode_id`.
- [ ] Stop hook integration: detached background subprocess; hook returns sub-millisecond.
- [ ] `robin biographer-catchup` CLI: bulk-processes pending events; `--retry-failed` revisits `failed_event_ids`.
- [ ] Host detection returns the correct adapter for each environment.
- [ ] `invokeLLM` Claude Code subprocess works against a real CLI (manual smoke test).
- [ ] `invokeLLM` Gemini works against the chosen mechanism (Path A or Path B) — both produce identical-shape outputs to a fake invokeLLM in unit tests; manual smoke test with real Gemini.
- [ ] Multi-host caching: cache hits observable in `usage` for both Claude Code and Gemini.
- [ ] Migrator-compatibility: `events.biographed_at` can be backfilled to `now()` without triggering biographer.
- [ ] Concurrency: two `biographer process-pending` invocations on overlapping event sets don't double-extract.
- [ ] Prompt caching annotations present; cache-hit ratio measurable in `usage`.
- [ ] CI green on ubuntu + macos (host adapter mocked in CI).
- [ ] CHANGELOG updated.

## 7. Open questions / risks

| Item | Resolves how |
|---|---|
| Gemini CLI `invokeLLM` exists? | Verification spike at start of plan picks Path A (subprocess, no API key) or Path B (direct Google API, requires `GEMINI_API_KEY` + per-token billing). Either way, Gemini ships in 2a — but Path B introduces a meaningful asymmetry vs Claude Code. Setup docs must call this out. |
| Gemini `cachedContent` minimum-size floor | Adapter creates cache only when cacheable token-count exceeds model floor; sub-floor calls go uncached. Coverage estimated ~70% on Gemini vs ~95% on Anthropic. |
| Real-data quality of cascade thresholds | Tune in 2c after v1→v2 migration provides real entity collisions. Defaults (0.92/0.80) live in `runtime:biographer.config`. |
| Background biographer crashes silently | Detached subprocess writes a heartbeat to `runtime:biographer.last_run_at`; `robin biographer-catchup --status` reports if no progress in N minutes. |
| `co_occurs_with` write amplification | Capped at top 8 entities; ≤56 UPSERTs/event (configurable in `runtime:biographer.config.cooccur_cap`). |
| Migrator cost on first run | Migrator (Phase 5) uses batched LLM calls; 2a's biographer unchanged. |
| MCP server `invokeLLM` overlap with 2b | Phase 2b's MCP server wraps 2a's adapter, doesn't replace. Adapter code outlives 2a. |
| Two consecutive Stop hooks racing on overlapping events | File lock + `biographed_at` dedupe at transaction commit; second background process exits cleanly when it finds events claimed. |

## 8. Next steps

1. User reviews this spec.
2. On approval, hand off to `superpowers:writing-plans` for the Phase 2a implementation plan.
3. Plan includes: Gemini verification spike + adapter implementation (Path A or Path B), `0003-graph-biographer.surql` migration, cascade resolution unit tests, biographer pipeline (with fake invokeLLM scaffolding), Claude Code host adapter (lifted from v1), unified multi-host prompt caching, fire-and-forget Stop hook wiring, CLI catchup command, integration tests.
4. Phase 2b plan (MCP server + first tools) starts immediately after 2a is implemented — same brainstorm → spec → plan cycle, no long gap.
