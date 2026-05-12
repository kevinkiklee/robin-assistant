# Robin v2 Phase 3b — v1→v2 Migrator + Missing Integrations + Cleanup

**Date:** 2026-05-10
**Status:** Design (pre-implementation, awaiting user approval)
**Predecessor:** Phase 2f at v6.0.0-alpha.7 (`b238616`).
**Companion:** Phase 3a (embedder profiles + Ollama + Gemini) — designed in parallel.
**Target tag:** v6.0.0-alpha.8 (or alpha.9 depending on which phase merges first).
**Build order:** 3a first, then 3b. 3b consumes 3a's `embedder.embed(text)` interface.

## 1. Scope and decomposition

Phase 3b ships v1→v2 data continuity, the last three v1 read-sync integrations, and two cleanup items in one bundle:

1. **`robin migrate-from-v1`** — top-level CLI that reads v1's rocksdb directly (read-only), maps tables → v2 schema, dedups via stable v1-id hash, resumes mid-run from a `runtime:migration_progress` row, lossy-preserves v1-only tables as events. Embeddings deferred to a background daemon job. Dry-run prints a per-table plan + cost estimate. v1 markdown is **skipped** (the residual 12 files are auto-regenerable or empty).
2. **`embed_backfill` daemon job** — singleton-cron drains rows where `embedding IS NONE`, batched, every ~10s. Lets the migrator land structurally fast while embeddings populate over minutes.
3. **`github` read-sync integration** — issues, PRs, notifications via `GITHUB_PAT`. Cadence 1h. Sibling to the existing `github_write`. One event per GitHub object (event/notification/release).
4. **`spotify` read-sync integration** — recently-played + top tracks/artists. OAuth (re-uses `SPOTIFY_*` from PROVIDERS registry). Cadence 4h. Sibling to `spotify_write`.
5. **`letterboxd` integration** — CSV-export ingest via `manifest.preflight()`. Drops files at `<package_root>/user-data/upload/letterboxd-*.csv`; sync reads, ingests, archives.
6. **30-day backup auto-prune** — `src/db/backup.js` `snapshot()` deletes archives in `backupDir` older than 30 days before writing the new tar.
7. **Encryption-decision documentation** — explicit "no encryption at rest" entry in CHANGELOG + new "## Security posture" section in `AGENTS.md`.
8. **Cutover runbook** — prescriptive section in this spec with literal commands.

**Path assumption.** All references to data home use `paths()` from `src/runtime/home.js`. Kevin has indicated `paths()` will return `<package_root>/user-data/{db,backup,secrets,models,logs}` (replacing the current `~/.robin/*` defaults). The migrator never hardcodes either form; it calls `paths()`. The home-path rework is **not owned by 3b**.

**Coordination with 3a.** 3a establishes the `embedder.embed(text)` polymorphic interface and pins HNSW dimension via `0008-embedder-<profile>.surql`. Phase 3b's migrator and `embed_backfill` job consume that interface and never know the dimension. 3a runs first; 3b builds on top.

**Realistic task count: ~42.**
- v1-table-mapping pass (8): capture, entity, episode, derived_from→episode_id, participates_in (the only edge that survives as an edge), lossy-preserve-as-events for 17 v1 tables (mentions, transaction, watch, the 8 v1-only normal tables, the 6 v1-only edge tables), audit/from_v1 enrichment.
- migrator scaffolding (7): CLI command, preconditions, v1-rocksdb client, dry-run planner, batch+transaction runner, `runtime:migration_progress` row + `runtime:migration_id_map`, `runtime:migration_failures`.
- audit/rework primitives (3): `--status` + `--show-failures` (1), `--reset` (1), `--export-mappings` + `audit-fixup.js.example` + `AUDIT.md` (1).
- embed_backfill (3): cron registration, batch drainer with poison-row exclusion, embedder integration.
- github read-sync (4), spotify read-sync (4), letterboxd (3).
- backup auto-prune w/ env override (1), encryption doc (1), cutover runbook section (1).
- AGENTS.md regen w/ Security posture block (1), CHANGELOG (1), tests (~4).

**Out of scope** (reserved for 3a or later): embedder pluggability, Ollama, Gemini API, profile selector, HNSW dim changes, `~/.robin/config.json`, `robin embedder switch`, `robin install` profile prompt.

## 2. `robin migrate-from-v1` architecture

### 2.1 CLI surface

```
robin migrate-from-v1 --source <v1-package-root>
                      [--dry-run] [--resume] [--max-batches N] [--phase <name>]
                      [--status] [--show-failures] [--reset [--phase <name>]] [--export-mappings <path>]
```

Migration mode (mutually exclusive with audit subflags):

- `--source` (required for migration runs): v1 package root (e.g. `~/workspace/robin/robin-assistant`). Migrator joins `<source>/user-data/runtime/db/data` to find v1's rocksdb.
- `--dry-run`: read both ends, print plan + cost table, write nothing.
- `--resume` (default behavior; flag for explicitness): resumes from `runtime:migration_progress` row if present.
- `--max-batches N`: cap a single invocation's work (debug aid).
- `--phase <name>`: run **only** the named phase (`entity`, `episode`, `capture`, `edges`, `lossy`, or a single lossy table like `lossy:preference`). Useful after `--reset --phase <name>` to selectively re-import with a tweaked mapping.

Audit / rework subflags (read-only or destructive-with-confirmation; do not need `--source`):

- `--status`: print the `runtime:migration_progress` row, per-phase counts, last-cursor, failure summary. Exits.
- `--show-failures [--phase <name>]`: pretty-print `runtime:migration_failures` rows (optionally filtered to one phase). Exits.
- `--reset [--phase <name>] [--dry-run]`: DELETE all rows where `meta.from_v1 IS NOT NONE` (and optionally `meta.from_v1.v1_table = <phase>`); clear the matching slot in `runtime:migration_progress`. Native non-migration captures are untouched (filtered by `meta.from_v1 IS NONE`). Prompts for confirmation unless `--dry-run`.
- `--export-mappings <path>`: write a JSON file with `{ entities: { v1_id: v2_id }, episodes: { v1_id: v2_id }, events: { v1_id: v2_id } }`. Lets Kevin author custom rework scripts that operate on the mapped IDs without re-running the migrator. Sourced from `meta.from_v1.v1_id` on each migrated row.

### 2.2 Preconditions (fail-fast)

In order, each with an actionable error message:

1. v2 daemon not running. Re-uses `readDaemonState()` + `isPidAlive()` from existing `migrate.js`.
2. v2 schema is at the latest migration. (Refuses if `runMigrations()` would have anything to apply — Kevin is meant to run `robin migrate` first; the migrator does not auto-migrate.)
3. v1 source path exists and contains `user-data/runtime/db/data/`.
4. v1 daemon is stopped. Verified by attempting to `connect({ engine: 'rocksdb://...' })` against v1's path: rocksdb is single-writer, so a running v1 daemon will fail the open with a lock error. We catch the error and print `"v1 appears to still be running — stop it first (e.g., kill its daemon process)"` rather than guessing at lock-file paths (v1's lock layout differs from v2's).

### 2.3 Architecture

```
src/cli/commands/migrate-from-v1.js     # CLI entry: parses args, dispatches to migrate / status / reset / export-mappings / show-failures
src/migrate-v1/
  index.js              # orchestrator: runs each phase in order, manages progress row
  v1-client.js          # opens v1 rocksdb read-only via @surrealdb/node, exposes paginated SELECTs
  plan.js               # dry-run planner: counts per v1 table + projects costs
  resolver.js           # in-memory Map<v1_id, v2_record_id> built by entity/episode phases, consumed by edges/capture
  phases/
    capture.js          # capture → events (uses resolver to set episode_id from derived_from)
    entity.js           # entity → entities (writes to resolver)
    episode.js          # episode → episodes (writes to resolver)
    edges.js            # participates_in only (uses resolver). v1 mentions handled in lossy.js — see §3.1.
    lossy.js            # 17 v1 tables → events with meta.kind='v1_<table>'
  audit.js              # builds meta.from_v1 + dedup hash; common helper
  failures.js           # writes runtime:migration_failures rows
  reset.js              # --reset destructive helper (filtered by meta.from_v1)
  export-mappings.js    # --export-mappings: dumps v1→v2 ID map as JSON
  status.js             # --status: pretty-prints progress row + counts
```

**ID resolver.** v1 record IDs (`entity:abc`, `episode:xyz`) are not the same as v2's (`entities:def`, `episodes:uvw`) — different table names *and* fresh ULIDs. The entity and episode phases write `Map<v1_id, v2_record_id>` entries to a shared `resolver`. Edge and capture phases consume it. The resolver also persists to `runtime:migration_id_map` as `{ v1_id: v2_id }` pairs after each phase completes, so a resumed run can rebuild the map without re-querying v2 by `meta.from_v1.v1_id`.

**Phase order** (matters for foreign-key resolution):
1. `entity` first → entity record IDs are needed by mentions/participates_in.
2. `episode` second → episode IDs needed by mentions and `events.episode_id`.
3. `capture` third → events get `episode_id` resolved by joining `derived_from` (a v1 RELATION).
4. `edges` fourth → `participates_in` (entities→entities) only. v1 `mentions` is **not** migrated as an edge; see §3.1.
5. `lossy` last → 17 v1 tables (mentions; the 8 normal v1-only: preference, correction, learning_question, prediction, action_outcome, action_trust, domain_confidence, communication_style; the 6 v1-edge: depends_on, relates_to, supersedes, cites, produces, knows; plus transaction and watch as archival), each row → one event with `meta.kind='v1_<table>'`, `meta.v1_payload=<full row>`. No embedding initially; embed_backfill picks them up.

### 2.4 Idempotency: dedup hash

Every imported row carries:
```js
meta.from_v1 = {
  v1_table: 'capture',
  v1_id: 'capture:abc123xyz',                  // already includes table prefix
  source_hash: sha256('v1:' + v1_id),          // e.g. sha256('v1:capture:abc123xyz')
  migrated_at: '2026-05-12T...'
}
```

Before any insert, the migrator first runs:
```surql
SELECT id FROM events WHERE meta.from_v1.source_hash = $hash LIMIT 1
```

This is indexed by `events_from_v1_hash` (added in `0009-migrator-v1.surql`). If found, skip. Otherwise insert with the audit trail.

The same dedup applies to entities (`entities` table) and episodes (`episodes` table) — each gets a `<table>_from_v1_hash` index in the same migration file.

### 2.5 Resume: `runtime:migration_progress`

Single row at `runtime:migration_progress` (uses existing `runtime` table — flexible value):
```js
{
  value: {
    v1_to_v2: {
      started_at: '2026-05-12T...',
      completed_phases: ['entity'],
      current_phase: 'episode',
      cursor: { last_v1_id: 'episode:xyz...' },
      counts: { entity: 949, episode_so_far: 12 }
    }
  }
}
```

Each phase iterates v1 rows in deterministic order (`ORDER BY id`), batches of 200, transactional. After every successful batch commits, update the progress row's cursor in a separate query (not in the same transaction — keep batch transactions narrow). On crash: re-run; phase reads progress, skips ahead to `cursor.last_v1_id`. If the same id failed mid-batch, the dedup query catches the half-imported row.

**Failures.** Per-row exceptions land in `runtime:migration_failures.value` as `{ v1_table, v1_id, error_message, occurred_at }`. The run continues. Final summary:
```
✓ migration complete
  imported: 7,205 rows across all phases
  skipped (duplicates): 0
  skipped (errors): 3 (run `robin migrate-from-v1 --show-failures` to inspect)
  events to embed: 3,025 (background pass: see `robin mcp logs --follow`)
```

### 2.6 v1 read mode

`v1-client.js` opens `<source>/user-data/runtime/db/data/` via `@surrealdb/node` with:
```js
const db = await connect({ engine: `rocksdb://${path}` });
await db.use({ namespace: 'robin', database: 'main' });
```
Connection is read-only by convention (we never call `CREATE/UPDATE/DELETE/UPSERT/INSERT`). Closes deterministically on completion. No fallback to surreal-export or .surql parsing.

The v1 `db.use(ns, db)` namespace: 3b spec assumes `('robin', 'main')` based on v1's backup file's `OPTION` block. **Plan task 0:** grep v1's `system/scripts/` for the actual `db.use(...)` call before any migrator coding. Adjust if mismatched.

## 3. v1 → v2 table mappings

### 3.1 The mapping table

| v1 source | Count | v2 destination | Mapping notes |
|---|---|---|---|
| `capture` | 2,393 | `events` | `content` ← v1.body. `source` ← `'migration'`. `meta` ← `{ kind: 'v1_capture', v1_kind: capture.kind, v1_origin: capture.origin, v1_marker_id: capture.marker_id, ...capture.meta }`. `ts` ← v1.ts. `episode_id` resolved via v1 derived_from RELATION (one query per batch joins captures→episodes). `external_id` ← `'v1:capture:' + v1_id` so dedup also works for downstream re-imports. `embedding` ← NONE (backfill). `trust` ← `'trusted'`. `content_hash` ← sha256(content). `archived_at` from v1 carried into meta. |
| `entity` | 949 | `entities` | `name` ← v1.name. `name_lower` derived. `type` mapping: v1's 10-value enum (person/project/tool/decision/place/concept/integration/source/event/task) → v2's 5-value enum (person/place/project/topic/thing). Map: person→person, place→place, project→project, tool→thing, decision→topic, concept→topic, integration→thing, source→thing, event→topic, task→topic. `embedding` ← NONE (backfill at v2's dim). `meta` ← `{ kind: 'v1_entity', v1_kind, slug: v1.slug, aliases: v1.aliases, summary: v1.summary, ...v1.meta }`. `created_at` ← v1.created. |
| `episode` | 38 | `episodes` | `started_at` ← v1.started_at. `ended_at` ← v1.ended_at. `source` ← `'migration'`. `summary` ← v1.summary. `meta` ← `{ kind: 'v1_episode', v1_kind, title: v1.title }`. (v2 episodes don't have a title field; keep in meta.) |
| `derived_from` | 2,106 | NOT a v2 edge | v1 derived_from is `episode→capture`. v2 represents this with `events.episode_id`. So during the `capture` phase, the migrator pre-loads a `Map<v1_capture_id, v1_episode_id>` from derived_from, and sets `event.episode_id = <new-v2-episode-record>` for matching captures. No edge rows written. |
| `mentions` | 669 | `events` (lossy) | **Not** an edge migration. v1: `episode→entity` is coarse ("entity X was mentioned somewhere in episode Y"); naive amplification to v2's `events→entities` would emit one edge per (capture-of-episode × entity), producing ~42k edges (avg 63 captures/episode × 669 v1 rows) with mostly false positives. Pollutes the graph and hurts recall. Instead: each v1 mentions row becomes one event with `source='migration'`, `meta.kind='v1_mentions'`, `meta.v1_payload={ v1_episode_id, v1_entity_id, v2_episode_id, v2_entity_id }`. Biographer re-derives proper fine-grained `mentions(events→entities)` edges naturally as it processes the imported captures (Phase 4 work). The lossy events keep the v1 relationship audit-recoverable in case Kevin wants to seed biographer with the v1 hints. |
| `participates_in` | 167 | `participates_in` | 1:1, both `entity→entity`, no amplification. RELATE with ENFORCED schema. v1 fields v2 doesn't define (confidence, archived_at, derived_from, valid_from/until) preserved in `meta.v1_payload` on the v2 edge so an audit can recover them. |
| `preference` | 311 | `events` | One event per row. `source` ← `'migration'`. `content` ← v1.what_worked. `meta.kind` ← `'v1_preference'`. `meta.v1_payload` ← `{ what_worked, domain, signal_count, evidence_ids: [...], promoted_to_style }`. Phase 4's heuristic loop can later recluster these into `rule_candidates`. |
| `correction` | 88 | `events` | `content` ← `'corrected: ' + what_went_wrong + ' → ' + what_to_do`. `meta.kind` ← `'v1_correction'`. `meta.v1_payload` ← `{ what_went_wrong, what_to_do, domain }`. |
| `learning_question` | 25 | `events` | `content` ← v1.question. `meta.kind` ← `'v1_learning_question'`. `meta.v1_payload` ← `{ question, why_it_matters, domain, status, asked_at, resolved_at }`. |
| `prediction` | 0 | `events` (lossy) | Empty in current backup; covered for completeness. `content` ← v1.claim. `meta.kind` ← `'v1_prediction'`. |
| `action_outcome`, `action_trust` | 0, 0 | `events` (lossy) | Empty in current backup. Each row → one event with full payload. |
| `domain_confidence` | 13 | `events` (lossy) | `content` ← `'domain confidence (' + level + '): ' + domain + ' — ' + basis`. `meta.kind` ← `'v1_domain_confidence'`. |
| `communication_style` | 7 | `events` (lossy) | `content` ← v1.style_notes. `meta.kind` ← `'v1_communication_style'`. `meta.v1_payload.scope/domain/source_preferences`. |
| `depends_on, relates_to, supersedes, cites, produces, knows` | 121 / 83 / 44 / 36 / 32 / 3 = 319 | `events` (lossy) | One event per edge row. `content` ← `'<v1_table>: ' + v1.in.name + ' → ' + v1.out.name` (entity names looked up). `meta.kind` ← `'v1_<edge_table>'`. `meta.v1_payload` ← `{ v1_in_id, v1_out_id, v2_in_id (resolved), v2_out_id (resolved), confidence, valid_from, valid_until }`. Resolves v1 entity ids to v2 record links inline so future Phase 2 dream can rebuild edges if it wants. |
| `transaction` | 2,713 | `events` (lossy) | One event per row. `content` ← `'<date> · <payee> · <amount> · <category> · <notes>'`. `meta.kind` ← `'v1_transaction'`. `meta.v1_payload` ← full row (account, amount, category, payee, notes, lm_id, source_file, date). **Why not SKIP:** the `lunch_money` integration's API resync would overwrite any local edits (notes, recategorizations) Kevin made. Lossy preserve keeps an audit trail; the canonical refreshed copy still arrives via `lunch_money` on its next tick. Audit step can dedup if Kevin wants. |
| `embedding_cache` | 3,459 | **SKIP** | Cached at v1's 512-dim. v2 uses a different dim per active embedder profile. Re-derived deterministically from `events.content_hash` on backfill. |
| `watch` | 1 | `events` (lossy) | Subsystem dropped per foundation spec section 2.3, but preserving the one row as `meta.kind='v1_watch'` is trivial and lets an audit see what was configured. |
| `_migrations`, `_migration_failures` | n/a | **SKIP** | v1 internal — irrelevant to v2. |

### 3.2 Type-enum bridge (entity.kind)

The 10→5 mapping above is one of two non-trivial transformations. The other is captures' free-form `meta.kind` fanning into v2's `events.meta.kind` namespace. Both are simple table lookups, defined in `phases/entity.js` and `phases/capture.js` respectively, with an inline comment pointing back to this spec section.

### 3.3 New schema migration: `0009-migrator-v1.surql`

```surql
-- Phase 3b: v1 → v2 migrator support indexes + embed-backfill field + edge meta

-- Source-hash indexes for dedup queries
DEFINE FIELD meta.from_v1.source_hash ON events       TYPE option<string>;
DEFINE FIELD meta.from_v1.source_hash ON entities     TYPE option<string>;
DEFINE FIELD meta.from_v1.source_hash ON episodes     TYPE option<string>;
DEFINE INDEX events_from_v1_hash    ON events    FIELDS meta.from_v1.source_hash;
DEFINE INDEX entities_from_v1_hash  ON entities  FIELDS meta.from_v1.source_hash;
DEFINE INDEX episodes_from_v1_hash  ON episodes  FIELDS meta.from_v1.source_hash;

-- Edge meta — preserves v1 fields v2 schema doesn't define.
-- Only participates_in needs this: v1 mentions → events (lossy), no edge migration.
DEFINE FIELD meta ON participates_in TYPE option<object> FLEXIBLE;

-- Embed-backfill: a top-level marker field, no index
-- (Backfill query is `WHERE embedding IS NONE`; no index helps a NONE-check
-- on an unindexed field at this corpus size, and SurrealDB doesn't support
-- partial indexes. Full table scan over ~3K migrated rows is fine.)
DEFINE FIELD embedded_at ON events TYPE option<datetime>;
DEFINE FIELD meta.embed_failed ON events TYPE option<bool>;
```

(Filename uses `0009-` to leave `0008-` for 3a's embedder migration. If 3a's embedder migration is `0008-embedder-<profile>.surql` and ships first, this file's numbering is correct; otherwise rename to `0010-` at PR-merge time.)

The indexes are non-unique (multiple v1 sources possible in the future) but selective enough for the dedup query.

### 3.4 Dry-run output format

```
v1 → v2 migration plan (dry-run, no writes)
(numbers below are illustrative based on the 2026-05-10 backup; live counts will vary)

  v1 table              v2 target                  src     dup    write
  capture               events                    2393      0    2393
  entity                entities                   949      0     949
  episode               episodes                    38      0      38
  derived_from          events.episode_id (folded)2106      0    2106
  mentions              events (lossy, kind=v1_mentions) 669  0     669
  participates_in       participates_in            167      0     167
  preference            events (kind=v1_preference) 311      0     311
  correction            events (kind=v1_correction)  88      0      88
  learning_question     events (kind=v1)            25      0      25
  domain_confidence     events (kind=v1)            13      0      13
  communication_style   events (kind=v1)             7      0       7
  depends_on            events (kind=v1)           121      0     121
  relates_to            events (kind=v1)            83      0      83
  supersedes            events (kind=v1)            44      0      44
  cites                 events (kind=v1)            36      0      36
  produces              events (kind=v1)            32      0      32
  knows                 events (kind=v1)             3      0       3
  transaction           events (kind=v1, archival)2713      0    2713
  watch                 events (kind=v1)             1      0       1
  embedding_cache       SKIP (re-derived from content_hash)
  prediction, action_outcome, action_trust    (empty in current backup)
  _migrations, _migration_failures   SKIP (v1 internal)

  Totals
    events written           : ~6,540  (5,870 lossy/regular + 669 from v1 mentions)
    entities written         : 949
    episodes written         : 38
    edges written            : 167  (participates_in only; mentions become events)
    rows to embed (events)   : ~6,540
    projected size           : variable; HNSW dim depends on active embedder profile (3a)
```

Re-running with prior `--resume` state populates the `dup` column with already-imported counts. Numbers are estimates from the 2026-05-10 v1 backup; the migrator queries v1 live for actual counts at run time.

## 4. Embedding backfill daemon job

### 4.1 Why

The migrator lands ~3,500 events without embeddings. Foreground re-embedding would block recall for tens of seconds and would never amortize across re-runs. Background job: rows visible immediately for source/time filters; vector recall fidelity climbs over the few minutes the backfill runs.

### 4.2 Design

A new singleton entry in the existing heartbeat scheduler at `src/integrations/_framework/run-sync.js` (or wherever cron entries live; the spec implementation will inspect the actual file at task time). Cadence: every **10 seconds** while there's work; idles when there isn't.

```js
// Pseudocode
async function embedBackfillTick(deps) {
  const rows = await deps.db.query(surql`
    SELECT id, content FROM events
    WHERE embedding IS NONE
    ORDER BY ts ASC
    LIMIT 64
  `).collect();
  if (rows.length === 0) return { embedded: 0 };
  // WHERE-clause excludes poison rows; query in the spec note above is canonical
  const vecs = await deps.embedder.embedBatch(rows.map(r => r.content));
  for (let i = 0; i < rows.length; i++) {
    await deps.db.query(surql`
      UPDATE ${rows[i].id} SET embedding = ${Array.from(vecs[i])}, embedded_at = time::now()
    `).collect();
  }
  return { embedded: rows.length };
}
```

Notes:
- Batch size 64 matches the embedder's batch shrink-on-OOM upper bound.
- Per-row UPDATE (not bulk) because SurrealDB v3 `UPDATE` with arrays of unique vectors per row gets clunky. Acceptable: 64 round-trips amortize fine at one tick / 10s.
- `events.embedded_at: option<datetime>` field added in `0009-migrator-v1.surql` (Section 3.3).
- Cron entry registered as `__embed_backfill__` (similar to existing `__dream__` special entry per Phase 2d's run-sync). No manifest, no MCP tool.
- Single fixed cadence (10s). No idle-relax logic — daemon-cron polling at 10s with an empty SELECT-LIMIT-64 is cheap (~ms), and the simplicity is worth more than the saved cycles.
- Daemon log line per tick when work is done: `[embed_backfill] embedded 64 events (latency 1.8s)`. Quiet when idle.
- Per-row try/catch: a poison row that crashes the embedder gets `meta.embed_failed = true` and is excluded from future ticks via `WHERE embedding IS NONE AND meta.embed_failed IS NOT true`. Failures also land in `runtime:migration_failures`. Audit query to find them: `SELECT id, content FROM events WHERE meta.embed_failed = true`.

### 4.3 Interaction with new captures during backfill

The integrations + capture-helper already write events with their own embeddings (each `ctx.capture()` calls embedder). So fresh captures don't queue for backfill — only migrated rows do. No starvation risk.

### 4.4 Polymorphic embedder dependency

Pulls `embedder` from the same shared singleton the daemon already owns. After 3a lands, that singleton is whichever profile is active (mxbai/qwen3/gemini). 3b's `embed_backfill` doesn't know or care.

## 5. `github` (read sync) integration

### 5.1 Manifest

```js
// src/integrations/github/manifest.js
import { sync } from './sync.js';
import { createGithubRecentActivityTool } from './tools/github-recent-activity.js';
import { createGithubNotificationsTool } from './tools/github-notifications.js';

export const manifest = {
  name: 'github',
  cadence: '1h',
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: { env_keys: ['GITHUB_PAT'] },
  sync,
  tools: [createGithubRecentActivityTool, createGithubNotificationsTool],
};
```

### 5.2 Sync shape

One event per GitHub object, mirroring the v2 pattern (`gmail`, `linear`):

| Captured object | external_id | content shape |
|---|---|---|
| User event from `/users/<me>/events` | `github:event:<event_id>` | `<repo>: <event_type> — <describe(event)>` (lifted describeEvent helper from v1) |
| Notification from `/notifications` | `github:notif:<thread_id>` | `<repo>: [<reason>] <subject_type> — <subject_title>` |
| Release from starred repos | `github:release:<repo>:<tag>` | `<repo> released <tag>: <name>` |

`meta` carries `{ kind: 'github_<activity|notif|release>', repo, raw: <subset> }`.

**Cursor:** `{ last_event_id, last_notif_updated_at, last_release_published }`. First sync caps event-list at 300, notifications at 50 with `?since=<7d>`, releases scans up to 50 starred repos (matches v1).

**Auth:** plain bearer with `GITHUB_PAT`. No OAuth dance — the v1 sync uses a PAT and the v2 `github_write` already does. **`github` read-sync imports REST helpers from `src/integrations/github_write/client.js`** (no duplicate file). If a helper is needed only by read or only by write, it lives there with a one-line comment about which sibling uses it. If shapes diverge later, refactor as a follow-up.

**Fine-grained-PAT 403 on `/notifications`:** logged once, integration continues with empty notifications list. Mirrors v1 behavior.

### 5.3 MCP tools

| Tool | Args | Live or DB |
|---|---|---|
| `github_recent_activity` | `{ days?, repo?, limit? }` | DB |
| `github_notifications` | `{ unread?, limit? }` | DB |

Both pure-DB. No live-fetch tool in 3b's scope — the existing `github_write` covers active operations.

## 6. `spotify` (read sync) integration

### 6.1 Manifest

```js
// src/integrations/spotify/manifest.js
import { sync } from './sync.js';
import { createSpotifyRecentlyPlayedTool } from './tools/spotify-recently-played.js';
import { createSpotifyTopItemsTool } from './tools/spotify-top-items.js';

export const manifest = {
  name: 'spotify',
  cadence: '4h',
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: {
    env_keys: ['SPOTIFY_REFRESH_TOKEN', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'],
    oauth: { provider: 'spotify', scopes: ['user-read-recently-played', 'user-top-read'] },
  },
  sync,
  tools: [createSpotifyRecentlyPlayedTool, createSpotifyTopItemsTool],
};
```

OAuth provider is already in the PROVIDERS registry from Phase 2f, with `rotatesRefreshToken: true`. Read scopes don't conflict with the write scopes already declared for `spotify_write` — manifests declare independent scope sets and `robin auth spotify --code` unions them.

### 6.2 Sync shape

| Captured object | external_id | content shape | Notes |
|---|---|---|---|
| Recently-played track | `spotify:played:<played_at_iso>` | `played <track> by <artists> — <album>` | append-only, dedup on `played_at` |
| Top track (one event per (window × month × track)) | `spotify:top_track:<window>:<YYYY-MM>:<track_id>` | `top track (<window>) <YYYY-MM>: <track> by <artists>` | month-bucket in id gives a fresh monthly snapshot; insert-or-skip dedups within the same month |
| Top artist | `spotify:top_artist:<window>:<YYYY-MM>:<artist_id>` | `top artist (<window>) <YYYY-MM>: <artist> — <genres>` | same |

Three windows: `short_term` (4w), `medium_term` (6m), `long_term` (all-time). Each tick captures all three. **API budget per tick: ~7 calls** (1 `/me`, 1 recently-played, 3 top tracks, 3 top artists). Comfortable inside Spotify's rate limits at 4h cadence.

**Month-bucket rationale.** Without `<YYYY-MM>` in the external_id, insert-or-skip would record each top-track only the first time it ever appeared in your top-50 — losing the temporal trail entirely. With it, each month's snapshot persists, dedup still suppresses the within-month re-captures, and recall can answer "what were my top tracks last December". 4h cadence × 6 refreshes/day = 6 dedup-probe-bursts/day; storage growth is bounded (50 unique tracks per window per month, max).

**Gap detection.** Spotify's recently-played endpoint caps at 50 tracks. If you play >50 tracks in a 4h window between two ticks, the older plays fall off the API window and we lose them. v1 detected this by comparing the oldest returned `played_at` to the cursor's `last_played_at`; if oldest > cursor, log a warning. v2's sync mirrors that: log `[spotify] gap detected: >50 plays since last sync; consider tighter cadence` to daemon stderr; doesn't block.

**Skipped from v1:** audio-features (deprecated by Spotify Nov 2024 for new apps; v1 already 403s), playlist snapshots (heavy, mostly static; out of scope for parity). Documented as such in CHANGELOG.

**Cursor:** `{ last_played_at, last_top_refresh_at, last_gap_warning_at }`.

**Auth:** through `getAccessToken({ provider: 'spotify', secrets: ctx.secrets, fetchFn: ctx.fetchFn, saveSecret: ctx.saveSecret })`. Refresh-token rotation handled by token-cache — same as `spotify_write`.

### 6.3 MCP tools

| Tool | Args | Live or DB |
|---|---|---|
| `spotify_recently_played` | `{ limit?, since? }` | DB |
| `spotify_top_items` | `{ kind: 'tracks' \| 'artists', window: 'short' \| 'medium' \| 'long' }` | DB |

## 7. `letterboxd` (CSV ingest)

### 7.1 Manifest

```js
// src/integrations/letterboxd/manifest.js
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../runtime/home.js';
import { sync } from './sync.js';
import { createLetterboxdRecentTool } from './tools/letterboxd-recent.js';

function uploadDir() {
  return join(paths().home, 'upload');
}

export const manifest = {
  name: 'letterboxd',
  cadence: '1h',
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: { env_keys: [] },
  preflight: async () => {
    // Only verify the upload directory exists; CSV presence is a soft check
    // inside sync() so dropping a CSV later doesn't require a daemon restart.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(uploadDir(), { recursive: true });
  },
  sync,
  tools: [createLetterboxdRecentTool],
};
```

Letterboxd has no API. Kevin exports a CSV from letterboxd.com and drops it at `<package_root>/user-data/upload/letterboxd-*.csv`. The integration's preflight just ensures the upload directory exists. CSV presence is a **soft check inside `sync()`**: if the directory has no `letterboxd-*.csv`, `sync()` returns `{ count: 0 }` without error, and Kevin can drop a CSV any time after install — no daemon restart needed (avoiding Phase 2f's known-limitation #9 where preflight-gated integrations only re-evaluate at boot).

### 7.2 Sync shape

CSV columns Letterboxd's "Diary" export produces (typical): `Date, Name, Year, Letterboxd URI, Rating, Rewatch, Tags, Watched Date`.

Per-row capture:
- `external_id`: `letterboxd:diary:<watched_date>:<slug-from-uri>` (slug from URI ensures stability across export re-runs).
- `content`: `watched <Name> (<Year>) — <Rating>★<rewatch_marker>`.
- `meta`: `{ kind: 'letterboxd_diary', name, year, rating: float-or-null, rewatch: bool, tags: array, watched_date, uri }`.
- `ts`: parsed from `Watched Date`.

Cadence 1h. Each tick scans `<package_root>/user-data/upload/` for `letterboxd-*.csv`, parses each, captures via `ctx.capture()` which dedups by `external_id`. After successful import, the file is **moved** to `<package_root>/user-data/upload/processed/<original-name>` so the next tick doesn't re-scan it. Errors leave the file in place with an `.error.txt` sibling.

CSV parsing: minimal hand-rolled (Letterboxd's export is RFC-4180 plain commas, no embedded quotes/newlines in user-typed fields). No new dependency.

**Format detection.** Letterboxd's export bundle contains multiple CSVs (Diary, Watched, Reviews, Ratings, Watchlist). 3b supports **only Diary** (`diary.csv` or `letterboxd-*-diary*.csv`); other files in the upload dir are ignored with a one-line stderr log per filename per tick. The parser identifies a Diary CSV by checking that the header row contains `Date`, `Name`, `Year`, `Letterboxd URI`, `Watched Date` (case-insensitive). Missing columns → file moved to `processed/<name>.unrecognized` with an `.error.txt` sibling explaining what was missing. This keeps the integration robust against Letterboxd's other export shapes; supporting Reviews/Watched is a follow-up if Kevin wants it.

### 7.3 MCP tool

| Tool | Args |
|---|---|
| `letterboxd_recent` | `{ days?, limit?, min_rating? }` |

## 8. Backup auto-prune (30-day)

### 8.1 Where

`src/db/backup.js`'s `snapshot(srcDir, backupDir)` extends to delete archives older than 30 days **before** writing the new tar.

```js
// existing snapshot() head
let entries;
try {
  entries = await readdir(srcDir);
} catch (e) {
  if (e.code === 'ENOENT') return null;
  throw e;
}
if (entries.length === 0) return null;

// NEW: prune. Retention configurable via ROBIN_BACKUP_RETENTION_DAYS env var
// (default 30). Set to 0 to disable pruning entirely.
const retentionDays = Number(process.env.ROBIN_BACKUP_RETENTION_DAYS ?? 30);
const pruned = retentionDays > 0
  ? await pruneOldBackups(backupDir, retentionDays * 24 * 60 * 60 * 1000)
  : 0;

const archive = join(backupDir, `${timestamp()}.tar`);
// ...rest unchanged; log line includes pruned count when > 0
```

```js
async function pruneOldBackups(backupDir, maxAgeMs) {
  const now = Date.now();
  let entries;
  try { entries = await readdir(backupDir); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  let pruned = 0;
  for (const f of entries) {
    if (!f.endsWith('.tar')) continue;
    const full = join(backupDir, f);
    const st = await stat(full);
    if (!st.isFile()) continue;       // defensive: skip if a directory happens to be named *.tar
    if (now - st.mtimeMs > maxAgeMs) {
      await unlink(full);
      pruned++;
    }
  }
  return pruned;
}
```

Pruning happens **before** the new snapshot writes, so a failed snapshot still keeps yesterday's backup intact (we only prune older-than-30d files). Pruned-count goes into the `backup: <archive>` log line: `backup: <archive> (pruned 4 older than 30d)`.

### 8.2 Coordination with 3a

3a probably doesn't touch `src/db/backup.js`. If they do (to add a profile-marker file inside the tar, say), conflict is a 3-line merge. Acceptable.

## 9. Encryption-at-rest documentation

### 9.1 Decision

`<package_root>/user-data/db/` is **not encrypted at rest.** RocksDB has no built-in encryption layer; v2 explicitly chose RocksDB for embedded simplicity. Filesystem-level encryption (FileVault on macOS, LUKS on Linux) is the user's responsibility.

### 9.2 Where it lives

**CHANGELOG.md** — under `[6.0.0-alpha.X]` Phase 3b entry:
> **No encryption at rest.** v2's embedded SurrealDB stores all memory unencrypted on disk. Rely on filesystem-level encryption (FileVault, LUKS, etc.) for confidentiality. This is a single-user local install; threat model assumes the device itself is trusted. Revisit if v2 ever ships in shared/multi-tenant contexts.

**AGENTS.md** — new `## Security posture` section, populated for the first time (Phase 3b is the first phase to commit anything beyond the placeholder):
> ### Security posture
> - **Storage:** unencrypted local SurrealDB at `<package_root>/user-data/db/`. No PII redaction at write-time. Treat the directory as containing the user's full personal context.
> - **Secrets:** `<package_root>/user-data/secrets/.env` (mode 0600). Read on demand; never persisted to `process.env`. Code paths and tests are reviewed to avoid logging secret values; the outbound-policy's secret-scanner runs against tool inputs (not arbitrary log output), so be mindful when adding new logging that touches secret-bearing variables.
> - **Outbound writes:** PII / secret / verbatim-untrusted-quote guards via `outbound/policy.js`. Rate-limited per tool.
> - **Trust model:** integration data is `trust='untrusted'`. Recall surfaces it but the agent must not quote untrusted content into outbound writes verbatim within the last 7 days.

The "Security posture" section lands via `agents-md.js` as a fenced auto-block similar to the integrations block, so it stays regenerable.

## 10. Cutover runbook

Run on a quiet evening. Total wall-clock: ~5 minutes structural import + ~5 minutes background embedding.

1. **Stop v1 daemon.** From `~/workspace/robin/robin-assistant`:
       ./bin/robin daemon stop      # whatever v1's stop command is
   Verify: `cat user-data/.lock` should be missing or PID dead.

2. **Final v1 backup.** Lift v1's existing backup script:
       cd ~/workspace/robin/robin-assistant
       node user-data/runtime/db/backup.js   # (v1's own helper)
   Confirms `user-data/runtime/db/backups/<today>.surql` is fresh.

3. **Stop v2 daemon (if running).** From `~/workspace/robin/robin-assistant-v2`:
       robin mcp stop

4. **Run v2 schema migrations.** Ensures 0008 (3a's embedder migration) and 0009 (3b's migrator indexes) are both applied:
       robin migrate

5. **Dry-run import.** Reviews the per-table plan + cost estimate:
       robin migrate-from-v1 --source ~/workspace/robin/robin-assistant --dry-run
   Verify: row counts match expectations (~7,200 imports, ~3,000 embeddings).

6. **Real import.**
       robin migrate-from-v1 --source ~/workspace/robin/robin-assistant
   Watches the per-phase progress. ~3-5 minutes structural at this corpus size. Final summary lists `events to embed: N`.

7. **Start v2 daemon.** Begins the `embed_backfill` job:
       robin mcp start
       robin mcp logs --follow         # optional: watch backfill progress
   Vector recall fidelity climbs over the next few minutes. Source/time recall is fully functional immediately.

8. **Spot-check.** Run a few recall queries via the MCP tool (`recall("...")`) and compare to v1's behavior — either by re-running the same query against a v1 snapshot DB, or by recalling content you remember should be there ("show me my preferences about X", "what was that correction about Y"). 15+ minutes after step 7, recall fidelity should match v1.

9. **Switch MCP servers.** Make sure `~/.claude/settings.json` and `~/.gemini/...` reference **only** the v2 MCP server. If v1 had registered itself in either host's MCP-server list, remove that entry — running both v1 and v2 MCP servers concurrently with the same tool names confuses the agent. Restart Claude Code / Gemini CLI after editing.

10. **Audit pass.** Use `robin migrate-from-v1 --status` and the audit primitives in §12 to spot-check what landed. If anything looks wrong, `--reset --phase <name>` and re-run with a fixed mapping. (Kevin has authorized a manual audit-and-rework pass after the initial migration; this is the moment for it.)

11. **Grace period.** Leave `~/workspace/robin/robin-assistant/` on disk (gitignored) until you're satisfied with v2 — at minimum a week of daily use. Don't delete during grace.

**Phase 3b's cutover ends at step 11.** v6.0.0 npm publish + GitHub archive is **Phase 4's gate** (daily-use parity), not Phase 3b's. During the grace period, Robin runs from the local v2 repo (`cd ~/workspace/robin/robin-assistant-v2 && bin/robin ...`) — v1 is the rollback safety net, v6.0.0 publish doesn't happen yet.

**Rollback (if any step fails irrecoverably):**
- Stop v2 daemon: `robin mcp stop`.
- Restore v2 from pre-cutover state: `rm -rf <package_root>/user-data/db/* && tar -xf <package_root>/user-data/backup/<pre-cutover>.tar -C <package_root>/user-data/db`.
- Restart v1: `cd ~/workspace/robin/robin-assistant && ./bin/robin daemon start`.
- Re-attempt cutover later. The migrator's idempotency means re-running `migrate-from-v1` on a partially-populated v2 DB picks up where the prior run left off; the destructive rollback is only needed if the v2 schema state itself got corrupted.

## 11. Tests + open questions + success criteria

### 11.1 Tests

**Unit:**
- `migrate-v1/audit.test.js` — source_hash determinism, from_v1 shape.
- `migrate-v1/plan.test.js` — counts roll up correctly, SKIP rows are flagged, totals math right.
- `migrate-v1/phases/entity-kind-bridge.test.js` — every v1 enum value maps to a v2 value; no unmapped value falls through.
- `migrate-v1/phases/edges-amplification.test.js` — given a v1 episode with 3 derived_from captures and 2 mentions edges, expect 6 v2 mentions edges.
- `db/backup.test.js` — pruneOldBackups deletes >30d files; preserves <30d; preserves non-.tar siblings; ENOENT-tolerant.
- `embed-backfill.test.js` — drains rows where embedding IS NONE; idle relax-to-60s after K empty ticks; doesn't re-process embedded rows; poison row flagged.

**Integration:**
- `migrate-from-v1-end-to-end.test.js` — fixture v1 rocksdb (mem://) seeded with N rows per table; runs migrator; asserts v2 row counts + sample dedup.
- `migrate-from-v1-resume.test.js` — kill mid-phase; re-run with `--resume`; asserts no double-imports + completes.
- `migrate-from-v1-dry-run.test.js` — dry-run prints expected plan, writes nothing.
- `github-sync.test.js` — fixture HTTP responses, asserts events captured per object kind.
- `spotify-sync.test.js` — fixture HTTP responses, asserts top-items windows produce distinct external_ids.
- `letterboxd-sync.test.js` — fixture CSV in tmp upload dir, asserts events captured + file moved to processed/.

**Manual smoke** (Kevin's machine, before tag):
- Real `robin migrate-from-v1 --dry-run --source ~/workspace/robin/robin-assistant` — eyeball plan.
- Real import on a `ROBIN_HOME=/tmp/robin-test` clone — confirm idempotency + resume.
- Drop a real Letterboxd CSV, confirm capture.
- Restart daemon mid-backfill, confirm resume.

### 11.2 Open questions / known limitations

| # | Item | Resolution |
|---|---|---|
| 1 | v2's `paths()` shape (`<package_root>/user-data/...` vs `~/.robin/...`) | Owned outside 3b. 3b reads `paths()` and works regardless. |
| 2 | Migration number conflict with 3a (both want 0008?) | 3a owns `0008-embedder-<profile>`. 3b uses `0009-migrator-v1`. Verify at PR-merge time. |
| 3 | v1 namespace/database name drift (we assumed `('robin','main')`) | Plan task 0 greps v1's `system/scripts/` for the actual `db.use(...)` call before any migrator coding. |
| 4 | Letterboxd CSV column order changes | Header-based parsing detects columns by name; positional parsing not assumed. |
| 5 | Spotify rate limits during a long initial sync | Cadence is 4h; per-tick budget ~7 API calls; well below 100 req/min limit. |
| 6 | GitHub fine-grained PAT limitations on `/notifications` | Already handled in v1 sync; carry forward the 403-then-skip pattern. |
| 7 | embed_backfill stalling on a poison row | Per-row try/catch + `meta.embed_failed` exclusion clause. Failures land in `runtime:migration_failures`. Audit query in §4. |
| 8 | `transaction` lossy-preserved alongside `lunch_money` re-sync | Two sets of rows for the same transaction (one v1 archival event with kind=v1_transaction, one fresh lunch_money event). Acceptable; audit can dedup by `meta.lm_id`. Trade-off chosen so manual edits aren't silently lost. |
| 9 | Migrator run against a v2 DB that already has non-migration data | Migrator dedups by `source_hash`; native captures with no `from_v1` audit are untouched. Audit step verifies via `--status` count vs total rows. |
| 10 | `--reset` is destructive | Always prompts unless `--dry-run`. Re-runnable: re-import is idempotent. |
| 11 | Spotify top-items tick writes ~300 events per refresh | At 4h cadence: ~1,800/day, mostly dedup hits. Storage cost ~0; query cost ~300 dedup queries/tick. Acceptable; revisit if Spotify recall queries become slow. |
| 12 | v1 `recall_events`-equivalent? | v1 had no recall_events table; nothing to migrate. Phase 4's reranker starts fresh on v2's recall_events from cutover onwards. |

### 11.3 Success criteria for v6.0.0-alpha.8 (3b's tag)

(Section 12 below documents the audit/rework surface; success criteria for those primitives appear there.)



- `robin migrate-from-v1 --dry-run` prints plan + cost; writes nothing.
- `robin migrate-from-v1` against the live v1 corpus imports ~7,694 rows (~6,540 events + 949 entities + 38 episodes + 167 edges) and queues ~6,540 events for backfill.
- Re-running `robin migrate-from-v1` against the same v1 produces 0 net writes (full dedup) and reports it.
- Crashing mid-run and re-running with no flags resumes cleanly.
- `embed_backfill` daemon job drains the ~6,540-row backlog within ~30 minutes (real wall-clock varies by embedder profile).
- `github` read-sync shares `client.js` with `github_write`; both pass tests after the change.
- `spotify`, `letterboxd` integrations show in `integrations list` (`letterboxd` shows as `loaded` even with no CSV — it no-ops in sync()).
- 3 new integrations × MCP tools = +5 tools (github×2, spotify×2, letterboxd×1) → 49 total daemon surface.
- `letterboxd` works without daemon restart when a CSV is dropped after install.
- Backup auto-prune: a tarball with a fake old mtime gets deleted on next snapshot; recent ones survive; `ROBIN_BACKUP_RETENTION_DAYS=0` disables.
- `AGENTS.md` shows `## Security posture` section (regenerable).
- CHANGELOG entry under `[6.0.0-alpha.8]` covers all Phase 3b items, including the no-encryption disclosure.
- Cutover runbook section (this spec's Section 10) referenced from CHANGELOG.
- Audit/rework surface (§12): `--status`, `--show-failures`, `--reset`, `--export-mappings`, `--phase` all wired and tested. `AUDIT.md` walkthrough shipped.
- `npm test` passes (target ~540 tests, +~36 from 2f). `npm run lint` clean.
- 19 integrations total (`gmail, google_calendar, google_drive, youtube, ga, lunch_money, weather, ebird, nhl, linear, whoop, chrome, lrc, discord, github_write, spotify_write, github, spotify, letterboxd`).

## 12. Audit & rework surface

A first-class concern of 3b: after the initial cutover, Kevin runs a manual audit and reworks anything the mapping got wrong. The migrator is built so that pass is **easy and non-destructive of native data**.

### 12.1 CLI primitives (already enumerated in §2.1; recap)

| Command | Purpose | Side-effect |
|---|---|---|
| `robin migrate-from-v1 --status` | Pretty-prints `runtime:migration_progress` + counts per phase + failure summary | none |
| `robin migrate-from-v1 --show-failures [--phase <name>]` | Lists `runtime:migration_failures` rows | none |
| `robin migrate-from-v1 --export-mappings <path>` | JSON `{ entities, episodes, events: { v1_id: v2_id } }` | writes file |
| `robin migrate-from-v1 --reset [--phase <name>] [--dry-run]` | DELETE all rows where `meta.from_v1 IS NOT NONE` (optionally one phase, with cascade — see §12.1.1); clear progress slot | destructive — prompts unless `--dry-run` |
| `robin migrate-from-v1 --phase <name>` | Re-import one phase only (after `--reset --phase <name>`) | normal migration writes |

#### 12.1.1 `--reset --phase` cascade rules

v2's `mentions`, `participates_in`, etc. are `SCHEMAFULL TYPE RELATION ENFORCED` — deleting a referenced entity/event/episode would error. To make per-phase reset safe, `--reset --phase <X>` cascades through dependents in this order **before** deleting the requested phase:

| --reset --phase | Cascades through (in order) |
|---|---|
| `entity` | `edges` (participates_in where `meta.from_v1 IS NOT NONE`), then `lossy:knows/depends_on/relates_to/supersedes/cites/produces` (these reference v1 entity ids in their payloads — the events themselves are stand-alone but a stale `meta.v1_payload.v2_in_id` would dangle), then `entity` itself |
| `episode` | clear `episode_id` field on migrated events (one bulk UPDATE), then `episode` itself |
| `capture` | `edges` (no edges currently originate from migrated captures since mentions is lossy, but defensive in case Phase 4 adds biographer-derived edges; only deletes edges with `meta.from_v1 IS NOT NONE`), then `capture` |
| `edges` | (leaf — no cascade) |
| `lossy:<table>` | (leaf — no cascade) |
| (no --phase) | full wipe of every row with `meta.from_v1 IS NOT NONE` plus the entire `runtime:migration_progress`, `runtime:migration_id_map`, `runtime:migration_failures` rows |

`--reset --phase X --dry-run` prints the cascade plan without executing it. The cascade always preserves native (non-`from_v1`) data.

`--reset --phase X` without `--dry-run` prompts: `"This will delete N rows across {phases...}. Type 'reset' to continue:"`.

**Native data is never touched.** Every destructive op filters by `meta.from_v1 IS NOT NONE`. Captures, integration syncs, biographer outputs, dream outputs, anything written natively by v2 — all untouched.

### 12.2 DB query primer (paste into a SurrealQL session via the daemon's REPL or any future db-browser)

Common audit queries — kept here so Kevin doesn't have to re-derive them:

```surql
-- Everything that came from v1, by table
SELECT meta.from_v1.v1_table AS src, count() FROM events GROUP BY src ORDER BY src;

-- Migrated entities by mapped v2 type
SELECT type, count() FROM entities WHERE meta.from_v1 IS NOT NONE GROUP BY type;

-- Sample 10 events per v1 source (eyeball check)
SELECT id, content, meta.from_v1.v1_table, meta.kind FROM events
  WHERE meta.from_v1 IS NOT NONE LIMIT 10;

-- Find rows the embedder choked on
SELECT id, content FROM events WHERE meta.embed_failed = true;

-- Backfill progress (count of un-embedded rows)
SELECT count() FROM events WHERE embedding IS NONE AND meta.embed_failed IS NOT true;

-- Trace a specific v1 record forward
SELECT * FROM events WHERE meta.from_v1.v1_id = 'capture:abc123xyz';

-- Captures that didn't get an episode_id (~12% by v1 backup; check after migration)
SELECT count() FROM events
  WHERE meta.from_v1.v1_table = 'capture' AND episode_id IS NONE;

-- v1 mentions hints (lossy events) — can be replayed by biographer if Phase 4 wants
SELECT count(), meta.v1_payload.v2_episode_id AS episode FROM events
  WHERE meta.kind = 'v1_mentions'
  GROUP BY episode ORDER BY count DESC LIMIT 10;

-- Find lossy-archival events that probably want manual reshape
SELECT meta.kind, count() FROM events
  WHERE meta.kind IN [
    'v1_preference', 'v1_correction', 'v1_learning_question',
    'v1_communication_style', 'v1_domain_confidence',
    'v1_depends_on', 'v1_relates_to', 'v1_supersedes', 'v1_cites', 'v1_produces', 'v1_knows'
  ]
  GROUP BY meta.kind ORDER BY count DESC;

-- Migrated edges with preserved v1 confidence
SELECT id, in, out, meta.v1_payload.confidence FROM participates_in
  WHERE meta.from_v1 IS NOT NONE;
```

### 12.3 Hookable rework script (`scripts/audit-fixup.js.example`)

A template lands in `scripts/` showing how to write a one-off rework that consumes the migrator's outputs. Contract:

```js
// scripts/audit-fixup.js.example  (copy + edit; not committed as live code)
import { connect, close } from '../src/db/client.js';
import { paths } from '../src/runtime/home.js';
import { readFile } from 'node:fs/promises';

const mappings = JSON.parse(await readFile('./mappings.json', 'utf-8'));
// { entities: {v1: v2}, episodes: {v1: v2}, events: {v1: v2} }

const db = await connect({ engine: `rocksdb://${paths().db}` });
try {
  // Example: promote v1_correction events to rule_candidates
  const corrections = await db.query(`
    SELECT * FROM events WHERE meta.kind = 'v1_correction'
  `).collect();
  for (const c of corrections[0]) {
    // ... custom transform ...
    // CREATE rule_candidates SET ...
  }
} finally {
  await close(db);
}
```

3b ships the `.example` file alongside an `AUDIT.md` walkthrough at `<package_root>/docs/AUDIT.md` (or `docs/superpowers/runbooks/audit-after-migration.md`, depending on where Phase 3b conventions land at task time) showing 3-4 worked examples.

### 12.4 Reversibility properties summary

- **Idempotency:** re-running the full migrator after a successful first run is a no-op.
- **Per-phase isolation:** `--reset --phase entity` followed by `--phase entity` re-imports just entities, preserving everything else.
- **Native data sanctuary:** all `--reset` operations filter by `meta.from_v1 IS NOT NONE`; nothing native is at risk.
- **Audit trail:** every migrated row carries `meta.from_v1.{v1_table, v1_id, source_hash, migrated_at}` for forensic queries.
- **Failure trail:** `runtime:migration_failures` accumulates skipped rows + reasons across all runs (cleared by `--reset` only).
- **Mapping export:** `--export-mappings` lets external scripts walk v1→v2 IDs without reading the full DB.

### 12.5 Success criteria for the audit/rework surface

- `--status`, `--show-failures`, `--export-mappings`, `--reset`, `--phase` all wired and tested.
- `--reset` against a non-migrated DB is a no-op (asserted in tests).
- `--reset --phase entity --dry-run` prints the cascade plan covering dependent edges and lossy v1-edge events; running without `--dry-run` cleans them up in dependency order without ENFORCED-relation throws.
- A one-line query for each common audit case in §12.2 verified against the seeded fixture set.
- `scripts/audit-fixup.js.example` runs end-to-end against a fixture DB.
- `AUDIT.md` walkthrough shipped.
