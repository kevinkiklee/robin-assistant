# v1 → v2 data migrator design

**Date:** 2026-05-11
**Status:** Approved for implementation
**Scope:** One-shot CLI to import Kevin's v1 markdown user-data into v2's SurrealDB.

## Goal

A single CLI command — `robin import-v1 --src <path-to-v1-user-data> [--dry-run] [--embed=sync|defer] [--rollback] [--session <id>] [--include-views]` — that reads v1's `user-data/memory/` markdown plus `user-data/sources/` and writes v2 rows into the embedded SurrealDB at `<robin_home>/db/`. Idempotent (content-hash dedup), no LLM/biographer calls at migration time. Embedder calls run as the final step via `system/cognition/jobs/internal/embeddings-backfill.js`.

## Non-goals

- Reading v1's running SurrealDB (`runtime/db/`). Markdown is the sole input.
- Running biographer/dream synchronously. Imported events carry `biographed_at=NULL`, `dreamed_at=NULL`; the heartbeat picks them up on its normal cadence.
- Two-way sync. v1 is frozen the moment this runs; migrator is one-directional.

## Daemon invariant

Refuses to run while the v2 daemon is up. Reuses the `readDaemonState` + `isPidAlive` pattern from `system/runtime/cli/commands/migrate.js`. RocksDB / SurrealKV are single-process; concurrent access would corrupt.

## Schema delta

New SurrealQL migration `system/data/db/migrations/0022-v1-imports.surql`:

```surql
DEFINE TABLE _v1_imports SCHEMAFULL TYPE NORMAL;
DEFINE FIELD source_path     ON _v1_imports TYPE string;
DEFINE FIELD content_hash    ON _v1_imports TYPE string;
DEFINE FIELD target          ON _v1_imports TYPE string;   -- "memos:<id>", "entities:<id>", etc.
DEFINE FIELD kind            ON _v1_imports TYPE string;   -- "memo"|"entity"|"edge"|"event"|"rule"|"refusal"|"persona_field"|"source_file"
DEFINE FIELD import_session  ON _v1_imports TYPE string;   -- ULID per `runImport` call
DEFINE FIELD imported_at     ON _v1_imports TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX _v1_imports_hash    ON _v1_imports FIELDS content_hash UNIQUE;
DEFINE INDEX _v1_imports_path    ON _v1_imports FIELDS source_path;
DEFINE INDEX _v1_imports_session ON _v1_imports FIELDS import_session;
```

Every migrated row also stamps `meta.imported_from='v1'` and `meta.v1_source_path` for in-row provenance.

**Content hash:** `sha256(source_path + '\n' + canonical_parsed_payload_json)`. Unique index makes re-runs O(1) skips.

## Source-tree → target mapping

| v1 path | v2 destination | Notes |
|---|---|---|
| `memory/ENTITIES.md` | **In-memory canonical-name table only.** Pass 0 builds `{canonical, aliases[], source_path}` lookups; no DB writes. | Provides canonical naming for subsequent passes. |
| `memory/knowledge/<topic>/<slug>.md`, `knowledge/<flatfile>.md` | `entities(type=<topic→type>, name=<canonical from Pass 0 ?? H1 ?? slug>, meta.aliases=[…])` + `memos(kind='knowledge', content=body)` + `edges:[about, memo, entity]` | One file = one memo (no sub-section decomposition). `frontmatter.last_verified` → `decay_anchor`; `frontmatter.decay` ∈ {`slow`,`medium`,`fast`,`immortal`} → confidence seed {0.9, 0.7, 0.5, 1.0}. Entity type from subdir (`service-providers`→`service`, `locations`→`place`, `projects`→`project`, `events`→`event`; default `concept`). |
| `memory/profile/<facet>.md` (Kevin facets) | `persona:singleton` MERGE structured fields where mapped + `memos(kind='profile_facet', meta.facet_slug=<basename>, content=body)` | Body always in a memo for FTS+vector recall. PERSONA_FACET_MAP: `identity`→`{name, pronouns}`; `interests`→`{interests}`; `personality`+`character`+`communication-style`→deep-merge into `comm_style`; `routines`→`meta.routines`. |
| `memory/profile/people/<slug>.md` | `entities(type='person', name=<canonical>, meta.aliases=[…])` + `memos(kind='knowledge', content=body)` + `edges:[about, memo, entity]` | No auto persona→person edge; the biographer derives those from events. |
| `memory/LINKS.md` | `edges:[mentions, source_memo, target_entity, meta.contexts=[<ctx>,…]]` | Target endpoint resolves to the **entity** corresponding to the linked file (since `mentions: out=[entities]` per edge-registry). UPSERT MERGE on `meta.contexts` so multiple rows with the same `(from, to)` accumulate contexts. Unresolved endpoints logged + skipped. |
| `memory/self-improvement/preferences.md` | `rules(kind='behavior' \| 'profile_update', active=true, priority=50, meta.source='v1-preferences')` | Pre-approved → straight to `rules`. Detector regex `/\b(call\|refer to\|name)\b.+?\b(as\|is)\b/i` switches to `'profile_update'`; else default `'behavior'`. |
| `memory/self-improvement/patterns.md` | `memos(kind='pattern', content=<each entry>)` | Default freshness half-life. |
| `memory/self-improvement/corrections.md` | `events(source='v1-correction', ts=<parsed date>, content=<entry>, meta.kind='correction', biographed_at=NULL, dreamed_at=NULL)` | Dream step-3 reflection clusters these into new `rule_candidates` over subsequent nights. |
| `memory/streams/{journal,log,decisions}.md` | One event per `## YYYY-MM-DD` section. `content`=full bulleted body. `ts`=midnight local. | `source='v1-journal'`/`'v1-log'`/`'v1-decision'`. |
| `memory/streams/inbox.md` | Same; dateless entries use file mtime, logged. | |
| `memory/watches/log.md` | `memos(kind='thread', content=<entry>, meta.status='watching', meta.kind='watch')` | |
| `memory/archive/` | `memos(kind='knowledge', meta.archived=true, confidence=0.3)` | Low-confidence; `fn::freshness` de-prioritises. |
| `memory/quarantine/` | `refusals(direction='inbound', content, reason='v1-quarantine', meta.from_v1=true)` | Audit only; never recallable. |
| `sources/**` | `cp -a` → `<robin_home>/sources/**` (= `user-data/sources/`) + `_v1_imports(kind='source_file')` | No DB content row; resolves file links in migrated memos. |
| **Skipped** | — | v1 top-level `archive/20260508-222124/`, `archive/20260509-150134-pre-empty/`, `memory.surrealdb-era/`, `runtime/`, `backup/`, `upload/`, `skills/`, `artifacts/`; `memory/{INDEX,MANIFEST,LINKS,ENTITIES,hot,tasks}.md` as memo bodies (LINKS/ENTITIES parsed for signal only); `profile/{INDEX,people,relationships}.md` (summary/index duplicates). Override the views skip with `--include-views`. |

## Pass order (within one run)

- **Pass 0** — Read `ENTITIES.md` into in-memory canonical-name table. No DB writes.
- **Pass A — Entities**: walk `knowledge/**` and `profile/people/**`. Create entities with canonical names + aliases from Pass 0.
- **Pass B — Memos + persona facets**: walk `knowledge/**`, `profile/<facet>.md`, `profile/people/**`, `watches/`, `memory/archive/`. Create memos and `edges:[about, memo, entity]`. UPSERT `persona:singleton`. **Long-content chunking**: if memo `content.length > 8000`, split at paragraph breaks (`\n\n`) into ≤6000-char chunks; create one parent memo (with brief lead paragraph) and N child memos linked via `edges:[derived_from, child, parent]`. Required because `embeddings-backfill.js` does not chunk.
- **Pass C — Cross-ref edges**: walk `LINKS.md`. Resolve `from_path` → memo, `to_path` → entity. Create `edges:[mentions, memo, entity]` with `meta.contexts` accumulation.
- **Pass D — Events**: walk `streams/**` and `self-improvement/corrections.md`. Create events with `biographed_at=NULL`, `dreamed_at=NULL`.
- **Pass E — Rules + patterns + refusals**: `self-improvement/{preferences,patterns}.md` → `rules`/`memos`. `quarantine/` → `refusals`.
- **Pass F — Sources copy**: `cp -a sources/ → <robin_home>/sources/`. One `_v1_imports(kind='source_file')` row per copied file.
- **Pass G — Embedding backfill** (default `--embed=sync`): invokes `embeddingsBackfill({db})` from `system/cognition/jobs/internal/embeddings-backfill.js`. Covers events + memos + entities. With `--embed=defer`, skip; heartbeat embeds in the background.

Across runs: order-independent via `_v1_imports.content_hash UNIQUE`.

## Module layout

```
system/runtime/install/v1-import/
  index.js                    # public API: runImport({ src, robinHome, dryRun, embed, sessionId })
  ledger.js                   # _v1_imports: hashExists, findByPath, recordImport, deleteSession, summary
  tx.js                       # withTx(db, async (tx) => …)
  passes/
    0-entities-md.js
    a-entities.js
    b-memos.js
    c-links.js
    d-events.js
    e-rules-patterns.js
    f-sources.js
    g-embed.js
  parsers/
    frontmatter.js            # YAML frontmatter + body split
    entities-md.js            # `- <Canonical> (<a1>, <a2>) — <path>`
    links-md.js               # `| from | to | context |`
    dated-entries.js          # /^(##|###)\s+(\d{4}-\d{2}-\d{2})(?:\s+—\s+(.+))?$/m
    list-of-entries.js
  writers/                    # every writer is transactional: row CREATE + ledger INSERT atomically
    entity-writer.js
    memo-writer.js
    edge-writer.js            # UPSERT edges:[kind, in, out] MERGE meta.contexts += [ctx]
    event-writer.js
    persona-writer.js
    rule-writer.js
    refusal-writer.js
  chunk.js                    # paragraph-split for >8000-char memo content
  taxonomy.js                 # KNOWLEDGE_SUBDIR_TO_TYPE, DECAY_TO_CONFIDENCE, PERSONA_FACET_MAP, PREFERENCE_KIND_DETECTORS
  report.js                   # ImportReport: counts, skips, conflicts, errors
```

CLI entrypoint: `system/runtime/cli/commands/import-v1.js`. Registered in `system/runtime/cli/commands.js` as `'import-v1'`.

## Writer behavior

Every writer wraps (row CREATE + ledger INSERT) in a `BEGIN/COMMIT` block via `withTx`. Aborted runs leave at most the last completed pair; never one without the other.

| Writer | Idempotency key | Conflict policy |
|---|---|---|
| `entity-writer.upsertEntity` | `(name_lower, type)` natural key; ledger hash as backup | Same `(name, type)` exists → MERGE `meta.aliases` union. Same canonical name with *different* `type` → both kept, logged to `report.notes.entity_alias_kept_both[]`. |
| `memo-writer.createMemo` | `content_hash` in `_v1_imports` | Skip on duplicate. On re-import with edited source: lookup old by `source_path` → CREATE new memo → `CREATE edges:[supersedes, new, old]` in same tx. |
| `edge-writer.upsertEdge` | composite ID `edges:[kind, in, out]` | UPSERT MERGE `meta.contexts += [ctx]`. |
| `event-writer.createEvent` | `content_hash` (source_path + ts + content) | Skip on duplicate. |
| `persona-writer.applyFacet` | facet_slug | Structured fields deep-merge; body always written as memo. |
| `rule-writer.createRule` | `content_hash` | Skip on duplicate. |
| `refusal-writer.createRefusal` | `content_hash` | Skip on duplicate. |

## Edge kinds used (per `EDGE_KIND_REGISTRY`)

- `about: memo → entity` — memo body is about the named entity.
- `mentions: memo → entity` — memo text references the entity (from LINKS.md).
- `supersedes: memo → memo` — new memo replaces old (re-import after edit).
- `derived_from: memo → memo` — child memo chunk derived from parent (long-content split).

## Idempotency edge cases

1. **Re-run, no changes** → hashes match, every writer skips. Report: `0 new, N already-imported`.
2. **Re-run after edit** → new hash. Writer looks up old by `source_path`, creates new row + `supersedes` edge in one tx. `fn::freshness` zeroes the old row's score.
3. **Re-run after deletion** → no source = no hash = no action. v2 row remains. (One-way migrator.)
4. **Mid-pass crash** → transactional writers ensure no orphans. Re-run resumes via hash skips.

## Report shape

Printed at end; also written to `<robin_home>/cache/v1-import-report-<sessionId>.json`.

```
=== robin import-v1 — report ===
Session:   <ULID>
Source:    <path>
Target:    <robin_home>
Started:   <ISO>
Duration:  <human>
Embedder profile: <profile> (from config.json)
Embed mode: sync | deferred

Imported (new):
  entities          N
  memos             N
  edges             N    (about: N, mentions: N, supersedes: N, derived_from: N)
  events            N    (journal: N, log: N, decisions: N, inbox: N, correction: N)
  rules             N
  patterns          N
  refusals          N
  persona fields    N
  source files      N

Skipped (already imported):  N

Notes:
  entity_alias_kept_both: N   (informational; e.g. "Google" exists as concept and service)

Warnings:
  unresolved_link:        N
  missing_source:         N
  undated_event:          N
  long_content_chunked:   N

Errors: N

Embedding backfill: <embedder summary> | Embedding: deferred — run `robin embed-backfill` …
```

## Failure modes

| Failure | Behavior | Operator action |
|---|---|---|
| Daemon running | Refuses: `daemon is running. Stop it first: robin mcp stop` | Stop daemon, re-run. |
| `--src` path doesn't look like v1 | Auto-detect: accepts `.../user-data` or `.../user-data/memory`. Refuses if `INDEX.md` not found at either location. | Provide correct path. |
| Target DB schema older than 0022 | Refuses: `please run 'robin migrate' first` | Run `robin migrate`. |
| Per-record write error | Logged to `report.errors[]`, pass continues. | Re-run after fixing root cause. |
| Pass-fatal (DB disconnect) | Run aborts. Ledger reflects partial state. | Re-run; hash skips replay completed work. |
| Embedder unavailable in Pass G | Pass G logs error; rows written but unembedded. | `robin embed-backfill` later, or re-run import. |

## Rollback

```
robin import-v1 --rollback [--session <id>]
```

- Without `--session`: rolls back the most recent session (looked up by `MAX(imported_at) GROUP BY import_session`).
- Deletes all `target` records in the session's ledger rows; cascade-on-delete edge triggers wipe associated edges.
- Deletes ledger rows themselves.
- Leaves `<robin_home>/sources/` filesystem copy untouched (operator removes manually).
- Reports counts per kind.

## Test strategy

- **Unit, per parser**: `system/tests/unit/v1-import/parsers/<name>.test.js`. Fixture string → expected records.
- **Unit, per writer**: spin up `mem://` SurrealDB, run migrations through 0022, exercise the writer twice — second call returns `action: 'skipped'`.
- **Integration**: `system/tests/integration/v1-import.test.js`. Fixture tree under `system/tests/fixtures/v1-userdata/` (~3 files per subdir). Run `runImport({src, robinHome: tmpDir, embed: 'defer'})` against fresh `mem://`. Assert row counts per table, presence of expected entities/edges/memos, no errors. Second run yields all-skipped. Rollback yields counts match.

## Build sequencing

Single feature branch `feat/v1-import`. Commits in narrative order:

1. `parsers/` + `taxonomy.js` + unit tests (pure functions).
2. `tx.js` + `ledger.js` + `writers/` + unit tests against `mem://`.
3. `0022-v1-imports.surql` + `passes/` + `index.js` + `chunk.js` + integration test.
4. `system/runtime/cli/commands/import-v1.js` + registry entry + `report.js` + `--dry-run` + `--rollback` + e2e test.
5. `docs/v1-to-v2-cutover.md` + CHANGELOG entry.

Default to one PR; split only if review burden warrants.

## Cutover runbook (excerpt — full version in `docs/v1-to-v2-cutover.md`)

```sh
# 0. Stop v1 daemon (whichever way you started it)
# 1. Back up v1 user-data
tar -czf ~/robin-v1-final-$(date -u +%Y%m%dT%H%M%SZ).tar.gz \
  -C ~/workspace/robin/robin-assistant user-data

# 2. v2 schema current
cd ~/workspace/robin/robin-assistant-v2 && robin migrate

# 3. Preview
robin import-v1 --src ~/workspace/robin/robin-assistant-v1/user-data --dry-run

# 4. Real run
robin import-v1 --src ~/workspace/robin/robin-assistant-v1/user-data

# 5. Validate counts
robin db query "SELECT count() AS n FROM memos WHERE meta.imported_from='v1' GROUP ALL;"

# 6. Semantic spot-check
robin recall "Kevin's PCP"
robin find-entity "Joony"
```

## Success criteria

After default `--embed=sync` run returns:

1. `recall("Kevin's PCP")` returns the memo from `knowledge/medical/pcp-yangdhar.md`.
2. `find_entity("Joony")` resolves to the Jake Lee entity via the `ENTITIES.md` alias.
3. `recall("Korean breakfast")` finds the `memos(kind='profile_facet')` carrying `profile/goals.md`.
4. Re-run reports `0 new, N already-imported`.

## Pre-build verification results

Verified by reading source during design:

- **Embedding**: `embeddings-backfill.js` (cognition/jobs/internal/) handles events + memos + entities. Pass G delegates to it. ✓
- **Chunking**: Neither backfill chunks long content. Our migrator pre-chunks at 8000-char threshold via `chunk.js`. ✓
- **Edge registry**: `mentions: memo → entity` enforced. LINKS.md edge target resolves to entity, not memo. ✓
- **CLI registry**: declarative table in `commands.js`; add `'import-v1'` leaf entry. ✓
- **Hash**: use `sha256` from `system/data/embed/hash.js`. ✓
- **Daemon guard**: copy pattern from `migrate.js` (`readDaemonState` + `isPidAlive`). ✓
