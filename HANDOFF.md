# DB + Memory Redesign — handoff

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

## Commits on this branch

```
$ git log --oneline main..HEAD
```
The expected sequence: spec → plan → verify gate → Wave 1 foundation → Wave 2 lenses → Wave 4 recall + reinforcement → (subagent's Wave 3 commits if landed) → this handoff.
