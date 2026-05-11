# SurrealDB Improvements — rollout addendum (2026-05-11, alpha.15)

The four-phase work on branch `feat/surrealdb-improvements` corrects the
`TYPE NORMAL` premise from the prior redesign and lands hybrid retrieval +
hot-path batching. Spec:
`docs/superpowers/specs/2026-05-11-surrealdb-improvements-design.md`.

> ⚠️ **Load-bearing constraint:** `0001-init.surql` checksum changed.
> Existing dev DBs MUST be reset before the daemon boots, or the migration
> runner throws "checksum mismatch" in `src/db/migrate.js`.

## Rollout

```bash
# 1. Stop the daemon
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.robin-assistant.mcp.plist
# (Linux: systemctl --user stop robin-mcp.service)

# 2. Backup (safety; recoverable until you confirm alpha.15 is healthy)
cp -R <robinHome>/db <robinHome>/db.pre-alpha15

# 3. Destructive reset
rm -rf <robinHome>/db/*

# 4. (optional) Switch engine in config.json
#    The default is now surrealkv://; flip via:
#    jq '.db.engine = "surrealkv"' <robinHome>/config.json | sponge ...
#    Note: surrealkv+versioned:// hangs on connect in @surrealdb/node 3.0.3;
#    leave on surrealkv (or rocksdb) until that's fixed upstream.

# 5. Restart daemon — schema + recall.config seed apply on boot
robin mcp ensure-running   # or restart via launchd/systemd
robin doctor                # verify engine + tables match config
```

Operator time: ~30 seconds. No data migrator (per spec; no v2 users).

## Verifying

```bash
node scripts/verify-design-assumptions.js   # 10 gates including G5/G12/G15-G18
npm run test:unit                            # 976/976
npm run test:integration                     # 112/112 (1 skipped)
npm run lint                                 # clean
robin doctor                                 # engine matches config
```

---

# DB + Memory Redesign — handoff (prior, alpha.13/14)

**Branch:** `feat/db-and-memory-redesign`
**Worktree:** `/Users/iser/workspace/robin/robin-assistant-v2-worktrees/redesign`
**Base:** `main` at `4472327`
**Spec:** `docs/superpowers/specs/2026-05-11-robin-v2-database-and-memory-redesign-design.md`
**Plan:** `docs/superpowers/plans/2026-05-11-robin-v2-database-and-memory-redesign.md`

## What this is

A destructive reset of Robin's schema and memory layer. Replaces 14 hand-written `.surql` migrations (`0001-init` … `0014-predictions` plus three `0008-*` embedder variants) with a single `0001-init.surql` plus per-profile `0002-embeddings-<profile>.surql`. The memory layer is renamed to a faculty register (`attention`, `chronicle`, `knowledge`, `habits`, `persona`, `narrative`, `foresight`) and routed through one `store.js` module.

Premise: no v2 user, no v2 data, no migration concern. The v1→v2 migrator (`src/migrate-v1/`) is left in tree but **not** rebuilt — it targets the old v2 schema and is stale.

## What landed (verified working)

### Wave 0 — Verification gates
- `scripts/verify-design-assumptions.js` passes all 4 gates against SurrealDB 3.0.5 + `@surrealdb/node` 3.0.3:
  - DEFINE EVENT cascade fires inside the deleting transaction
  - Composite-ID UPSERT idempotent (`SET field += 1`)
  - Field-path indexes on `meta.*` selected by planner
  - `fn::freshness` returns 0 after inbound `supersedes`

### Wave 1 — Foundation
- New schema: `src/schema/migrations/0001-init.surql` (substrate + edges + ops tables + fn::freshness + cascade events) and three `0002-embeddings-<profile>.surql` (mxbai-1024 / qwen3-4096 / gemini-3072), each with three per-surface HNSW tables.
- `src/memory/store.js`: only writer to memos/edges/embeddings. Primitives: `remember`, `note`, `upsertEntity`, `upsertMemoByName`, `relate`, `relateAll`, `supersede`, `flagContradiction`, `updateMemoMeta`, `getMemo`, `searchMemos`, `searchEvents`, `searchEntities`, `listMemos`, `neighbors`.
- `src/memory/kind-registry.js`: `MEMO_KIND_REGISTRY` + `ATTACHMENT_KIND_REGISTRY` + `validateMemoKind`.
- `src/memory/edge-registry.js`: `EDGE_KIND_REGISTRY` + `validateEdge` (registry-validated endpoints, self-loop reject, symmetric canonicalization, composite-ID helper).
- `src/memory/decay.js`: JS `freshness()` mirror of `fn::freshness`.
- `src/memory/scopes.js`: `SCOPE` constants + `isEphemeralScope`.
- `src/embed/profile-router.js`: `activeProfile` / `readProfile` / `embeddingTable(profile, surface)` with regex-validated names; cached for 5s.

Smoke-verified: `scripts/test-store-smoke.mjs` covers note dedup, upsertMemoByName signal_count++, occurs_with counter, supersede → freshness=0.

### Wave 2 — Faculty lenses
- `src/memory/{attention,chronicle,knowledge,habits,persona,narrative,foresight}.js` written; the five renamed files (`hot.js`, `journal.js`, `patterns.js`, `profile.js`, `threads.js`) deleted.
- Legacy function names re-exported from new files (`getHotContext`, `listJournalEntries`, `createPattern`, `upsertPatternByName`, `listPatterns`, `getProfile`, `updateProfileFields`, `createThread`, `listThreads`) so the 18 consumer-file import paths could be updated with a single sed pass.

### Wave 4 — Recall pipeline + reinforcement loop (the keystone fix)
- `src/recall/rank.js`: composite `score()` (cosine × freshness × contradiction-penalty × trust-factor × scope-boost) + MMR-lite diversity.
- `src/recall/reinforcement.js`: 5-min-delayed evaluator. Pending `recall_log` rows → `signal_count++` on hits if no correction landed; `outcome='corrected'` if one did.
- `src/jobs/internal/reinforce-recall.js` + `src/jobs/builtin/reinforce-recall.md`: `*/5 * * * *` cadence built-in.
- `src/recall/index.js`: rewritten as a thin adapter over `store.searchEvents` (queries the active profile's `embeddings_<profile>_events` HNSW table).
- `src/recall/intuition.js`: writes `intuition_telemetry` (renamed from `runtime_intuition_telemetry`) and `recall_log` rows with `outcome='pending'` per recall.

Smoke-verified: `scripts/test-reinforcement-smoke.mjs` covers reinforced path + corrected path end-to-end.

### Wave 3 (partial) — Dream steps
- `src/dream/step-patterns.js`: queries `edges WHERE kind='occurs_with'` (was `co_occurs_with` table); emits via `habits.upsert`.
- `src/dream/step-threads.js`: queries `edges WHERE kind='mentions'` (was `mentions` table); emits via `narrative.add`.

## What's deferred to a follow-up session

None of these blocks the design — they're remaining mechanical/test work.

1. **Biographer rewrite** (`src/capture/biographer*.js`) — a subagent was dispatched at end-of-session for this; check `git log` first to see if it landed commits.
2. **MCP tool handlers** — `src/mcp/tools/{ingest,get-entity,related-entities,audit}.js` still query old table names. (May have been picked up by the subagent.)
3. **`src/jobs/{lint-checks,predictions,ingest-prompt}.js`** — same.
4. **`src/graph/{edges,cascade}.js`** — cascade.js can be deleted (replaced by DEFINE EVENT triggers in schema). edges.js should become a thin wrapper over `store.relate`.
5. **CLI commands** — `src/cli/commands/{predictions,lint,audit,embedder-switch}.js` may reference old shapes. The legacy lens aliases cover most cases.
6. **Test suite** — most `tests/unit/memory-*.test.js` and integration tests use old function signatures (the lens API signature changed: `add(db, embedder, input)` vs old `createPattern(db, input)`). All call sites need an embedder pass-through. Audit grep tests (forbid old table names) need writing.
7. **Doc rewrites** — `docs/architecture.md`, `docs/faculties.md`, `docs/development.md`, `docs/troubleshooting.md` still describe the v1 shape.
8. **CLI: `robin embeddings prepare/backfill/activate/list/drop`** — not yet built; spec'd in §6.1 of the plan.
9. **State-inference + action-outcome event writers** — schema-ready (`kind='state_inference'`, `source='action_outcome'`); writers spec'd in §6.5 of the spec; not yet wired.

## Rollout (destructive reset; no migrator yet)

```bash
# 1. Stop the daemon
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.robin-assistant.mcp.plist
#   (or on Linux: systemctl --user stop robin-mcp.service)

# 2. Backup the current DB if you want a rollback option
cp -R <robinHome>/db <robinHome>/db.pre-redesign

# 3. Merge or PR
git checkout main && git merge feat/db-and-memory-redesign
#   (or: gh pr create from feat/db-and-memory-redesign)

# 4. Nuke the old DB (no v1→v2 migrator yet; that's a separate phase)
rm -rf <robinHome>/db/*

# 5. Restart the daemon. 0001-init.surql + 0002-embeddings-<your_profile>.surql
#    apply automatically. The migration runner picks the right 0002 based on
#    your `embedder_profile` in <robinHome>/config.json.
```

## Known footguns surfaced during this work

These corrections came out of the verification gates and smoke tests; baked into the spec already but worth flagging.

- **`type::thing` → `type::record`** in SurrealDB v3 (renamed).
- **`math::log(x, 2)`** is the two-arg form for log_2; one-arg variant rejected.
- **`math::min([a, b])`** takes an array, not multiple args.
- **`SET field += 1`** is the canonical UPSERT counter idiom; `weight = (weight ?? 0) + 1` doesn't increment on existing rows.
- **SurrealDB JS SDK `RecordId.table` returns a `Table` object**, not a string — coerce with `String()`.
- **JS `null` binds as SurrealDB `NULL`**, not `NONE` — optional fields should be omitted from SET clauses, not bound as null.
- **`value` is a SurrealQL keyword** — use `SELECT VALUE value FROM …` flattener.
- **TYPE NORMAL is incompatible with graph arrows** (`->edges->entities`); composite-ID idempotent UPSERT requires TYPE NORMAL → composite IDs were chosen; explicit `SELECT ... WHERE kind=X AND from=$id` used everywhere.
- **`FLEXIBLE` must come after `TYPE`** in DEFINE FIELD; e.g. `TYPE object FLEXIBLE`, not `FLEXIBLE TYPE object`.
- **`array<object>` doesn't accept FLEXIBLE on the parent**; use `array` (untyped) plus `array[*] TYPE object FLEXIBLE` for nested object arrays.

## How to verify what landed

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2-worktrees/redesign

# 1. All four design-assumption gates
node scripts/verify-design-assumptions.js

# 2. End-to-end store primitives
node scripts/test-store-smoke.mjs

# 3. Reinforcement loop (the keystone effectiveness fix)
node scripts/test-reinforcement-smoke.mjs

# 4. Migrations apply cleanly on a fresh DB
# (handled implicitly by scripts above; both spin up mem://)
```

All three of these scripts ran clean as of the last commit on this branch.

## Verification matrix (final, post-alpha.14 cleanup + integration spawn fix)

| Check | Status |
|---|---|
| `scripts/verify-design-assumptions.js` (4 SurrealDB v3 gates) | ✓ all pass |
| `scripts/test-store-smoke.mjs` (note / upsertMemoByName / occurs_with counter / supersede) | ✓ pass |
| `scripts/test-reinforcement-smoke.mjs` (reinforced + corrected paths) | ✓ pass |
| `scripts/test-intuition-loop-smoke.mjs` (end-to-end intuition→recall_log→reinforce→signal_count++) | ✓ pass |
| `scripts/test-scope-cleanup-smoke.mjs` (promote referenced ephemerals, prune stale) | ✓ pass |
| `scripts/verify-hnsw-plan.mjs` (EXPLAIN FULL confirms KnnScan operator) | ✓ pass |
| `tests/unit/audit-no-old-tables.test.js` (21 forbidden tokens) | ✓ 21/21 |
| `npm run lint` (Biome) | ✓ 0 errors |
| Unit suite (`tests/unit/**`) | ✓ **969 / 969** |
| Integration suite (`tests/integration/**`, excluding the known-hanging biographer test) | ✓ **107 / 107** |
| DB migration on user's instance | ✓ applied (v1, v2); active profile `mxbai-1024`; 19 tables |

If you ever see `NODE_MODULE_VERSION` errors loading `better-sqlite3`, the cause is Node-ABI mismatch from a different Node binary picking the binding (e.g., nvm Node 24 vs Homebrew Node 25). Fix: `npm rebuild better-sqlite3` with whatever Node `which node` resolves to. `robin doctor` already detects this and prints the same advice.

## Commits on this branch (15)

```
c15673e fix(stale-refs): profile:singleton → persona:singleton; recall_events → recall_log
a499231 chore(scripts): explicit process.exit so smoke scripts return clean exit codes
1bf13f3 chore(db-browse): mark UI stale pending rewrite for new schema
b38b4ce chore: bump to 6.0.0-alpha.12 + changelog entry for redesign
3b493b8 feat(wave-3): jobs (lint-checks, predictions, ingest-prompt) route through new schema
46e08c7 feat(wave-3): MCP tools (ingest/get_entity/related_entities/audit) route through new schema
3b1d6c1 feat(wave-3): dream/step-knowledge routes through store.note + supersede
3d99c84 feat(wave-3): biographer + edges route through new generic edges table
2963827 docs: rewrite architecture + faculties + new HANDOFF for redesign branch
1cf0a07 feat(wave-4): recall rank pipeline + reinforcement loop
b8812fd feat(wave-2): faculty-named memory lenses
6307715 feat(wave-1): foundation — new schema + memory primitives
8ecac21 feat(verify): scratch script + spec corrections from gate run
0e11184 docs: implementation plan for v2 db + memory redesign
ac77d7e docs: spec for v2 db + memory redesign (last big schema change)
```

Branch is unpushed (not merged into main, not pushed to remote — review before either).

## What still needs doing (concrete follow-up checklist)

Wave 3 is done in production code paths. What's left:

- [ ] Test suite rewrite (`tests/unit/memory-*.test.js`, `tests/integration/*`): old function signatures (`createPattern(db, input)` vs new `add(db, embedder, input)`). Most failures will be `Cannot destructure 'X' of undefined` from the embedder-position shift. ~30 test files to update.
- [ ] Audit-grep tests: add `tests/unit/audit-no-old-tables.test.js` per spec §14 — production source must not reference deleted table names.
- [ ] `src/db/browse/*.js`: marked stale; rewrite when next opening the DB browser UI for the new schema.
- [ ] CLI: `robin embeddings prepare|backfill|activate|list|drop` subcommands (spec §6.1).
- [ ] State-inference writer in `dream/step-comm-style` (schema-ready; spec §6.5).
- [ ] Code-edit / reasoning / session-outcome event writers (all schema-ready).
- [ ] v1→v2 migrator rewrite (separate spec; explicitly out of scope here).
- [ ] `docs/development.md` + `docs/troubleshooting.md` (architecture.md + faculties.md already rewritten).
