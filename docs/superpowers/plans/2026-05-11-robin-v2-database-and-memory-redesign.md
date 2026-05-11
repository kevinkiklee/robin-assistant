# Robin v2 — Database & Memory Layer Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reset Robin's schema and memory layer to the design in `docs/superpowers/specs/2026-05-11-robin-v2-database-and-memory-redesign-design.md`. One init migration, three substrate tables (events / memos / entities), single generic edges table, separable per-surface per-profile embedding tables, faculty-named memory layer, recall reinforcement loop, supersedes/contradicts belief evolution, open enums throughout.

**Premise:** This is a destructive reset. No v2 user, no v2 data. The v1→v2 migrator is left in tree but not rebuilt. The user has authorized destructive edits.

**Tech Stack:** Node.js 22+ (ES modules), `node --test`, `node:fs`/`node:path`, SurrealDB v3 (rocksdb), Biome.

**Spec:** `docs/superpowers/specs/2026-05-11-robin-v2-database-and-memory-redesign-design.md` (commit `ac77d7e`).

---

## How to work this plan

1. Tests live in `tests/unit/` and `tests/integration/`. Run all unit tests with `node --test --test-force-exit 'tests/unit/**/*.test.js'`. Integration suite excludes the known-hanging biographer test: `find tests/integration -name '*.test.js' ! -name 'biographer-process-pending-captures.test.js' -exec node --test --test-force-exit {} +`.
2. Before declaring a task done: run touched test files, then `npm run lint`, then `git status`.
3. Commit at end of each task with the shown message. Use `git add <specific files>`, never `git add -A`.
4. **Worktree:** This plan is already authored on `feat/db-and-memory-redesign` at `/Users/iser/workspace/robin/robin-assistant-v2-worktrees/redesign`. Operate there.
5. **Daemon:** Do NOT stop the user's running daemon. All testing happens against ephemeral DBs in `os.tmpdir()`-prefixed paths.
6. **Wave dependencies:** Earlier waves create primitives that later waves consume. Within a wave, tasks can parallelize via subagents where files don't overlap.

---

## Verification gates (Wave 0)

Run before Wave 1 starts. If any fails, adjust spec before continuing.

- [ ] **G0.1 — Scratch verification script.** Create `scripts/verify-design-assumptions.js`. Stands up an ephemeral SurrealDB v3 RocksDB; runs the four assertions from spec §13 (DEFINE EVENT transactionality, composite ID UPSERT idempotence, field-path index usability, fn::freshness correctness). Each assertion logs OK/FAIL.

- [ ] **G0.2 — Run script.** `node scripts/verify-design-assumptions.js`. All four OK. If any FAIL, surface the failure and pause for human input before continuing.

**Commit:** `chore(verify): scratch script for v2 redesign design assumptions`

---

## Wave 1 — Foundation (schema + store + registries)

Pure additive. Existing memory layer (`hot.js`, `journal.js`, etc.) untouched. Old migrations untouched until Wave 7. Daemon won't start cleanly until Wave 3 reconciles the capture path; that's fine — tests use ephemeral DBs.

### Task 1.1 — New init migration

- [ ] Replace `src/schema/migrations/` content (preserve directory, delete `0001`–`0014` plus three `0008-*` variants). Create new `0001-init.surql` containing the full schema from spec §4 (sections 4.1–4.6 inclusive plus the `fn::freshness` function from 4.5 plus the cascade events from 4.3).

Acceptance: `node scripts/verify-design-assumptions.js --schema 0001-init.surql` applies cleanly to a fresh DB. `SELECT * FROM _migrations` shows version 1.

**Commit:** `feat(schema): single 0001-init.surql replacing 14 v1 migrations`

### Task 1.2 — `src/memory/scopes.js`

- [ ] Create with `SCOPE` constants and `EPHEMERAL_SCOPE_PREFIXES` array per spec §5.4.
- [ ] Unit test `tests/unit/scopes.test.js`: each helper produces expected prefix; `EPHEMERAL_SCOPE_PREFIXES` is what we expect.

**Commit:** `feat(memory): scopes constants`

### Task 1.3 — `src/memory/kind-registry.js`

- [ ] Create with `MEMO_KIND_REGISTRY` and `ATTACHMENT_KIND_REGISTRY` per spec §5.2.
- [ ] Export `validateMemoKind(kind, payload) → { ok, errors[] }`. Validates `required` fields exist, `meta_schema` keys parse, unknown kinds return `{ok:true}` (open enum policy — code uses registry as advisory, not gate).
- [ ] Export `validateAttachment({ kind, ...rest })` similarly.
- [ ] Unit test `tests/unit/kind-registry.test.js`.

**Commit:** `feat(memory): MEMO_KIND_REGISTRY + ATTACHMENT_KIND_REGISTRY`

### Task 1.4 — `src/memory/edge-registry.js`

- [ ] Create with `EDGE_KIND_REGISTRY` per spec §5.3.
- [ ] Export `validateEdge(from, to, kind) → { ok, errors[] }`. Checks table allow-lists, self-loop rejection, symmetric semantics.
- [ ] Export `canonicalEndpoints(from, to, kind) → [from, to]`. For symmetric kinds, orders by `${tb}:${id}` ascending.
- [ ] Export `compositeEdgeId(kind, from, to) → 'edges:[...]'` (deterministic).
- [ ] Unit test `tests/unit/edge-registry.test.js`.

**Commit:** `feat(memory): EDGE_KIND_REGISTRY + validateEdge + canonical endpoints`

### Task 1.5 — `src/embed/profile-router.js`

- [ ] Read `runtime:embedder.value.active_profile` at boot (cached, refreshed on signal).
- [ ] Export `activeProfile()` and `readProfile()` (defaults to active when not in dual-read window).
- [ ] Export `embeddingTable(profile, surface)` → `"embeddings_<profile>_<surface>"`. Validates `profile` against `/^[a-z0-9_]+$/`. Surface ∈ `events|memos|entities`.
- [ ] Unit test `tests/unit/profile-router.test.js`.

**Commit:** `feat(embed): per-(profile, surface) embedding-table router`

### Task 1.6 — `src/memory/decay.js`

- [ ] Export JS `freshness(memo, { supersededCount = 0 })` matching `fn::freshness` math.
- [ ] Export `HALF_LIFE_BY_KIND_MS` constant (knowledge 180d, habit 60d, thread 30d, prediction 365d, default 90d).
- [ ] Unit test `tests/unit/decay.test.js`: freshness=0 when superseded; decays over time; signal_count boosts.

**Commit:** `feat(memory): freshness() JS mirror of fn::freshness`

### Task 1.7 — `src/memory/store.js` write primitives

- [ ] Create with these exports:
  - `remember(db, embedder, input)` — captures event; writes to `events` + `embeddings_<profile>_events`.
  - `note(db, embedder, kind, input)` — creates memo; writes lineage as `derived_from` edges, subjects as `about` edges; writes to `embeddings_<profile>_memos`.
  - `upsertEntity(db, embedder, input)` — three-stage cascade (exact→embedding→LLM) preserved from current `src/graph/stage*.js`; writes to `embeddings_<profile>_entities`.
  - `upsertMemoByName(db, embedder, kind, input)` — match on `(kind, meta.name)`; increment `signal_count`, refresh `last_active`, merge new lineage; or create new memo.
  - `relate(db, from, to, kind, opts)` — registry-validated; composite ID UPSERT; MERGE or counter-SET per kind.
  - `relateAll(db, rows[])` — bulk version using `BEGIN/COMMIT`.
  - `supersede(db, oldId, newId)` — adds `supersedes` edge.
  - `flagContradiction(db, idA, idB, opts)` — adds symmetric `contradicts` edge.
  - `updateMemoMeta(db, id, patch)` — for `foresight.resolve` and similar lifecycle updates.

- [ ] Unit tests covering each primitive (one test file per primitive cluster).

**Commit:** `feat(memory): store.js write primitives`

### Task 1.8 — `src/memory/store.js` read primitives

- [ ] Add to `store.js`:
  - `getMemo(db, id)` — hydrates subjects (`about` outbound), lineage (`derived_from` outbound), contradictions (`contradicts` either-side count), freshness via `fn::freshness`.
  - `searchMemos(db, embedder, query, opts)` — embeds query; HNSW on `embeddings_<profile>_memos`; JOIN-back to memos; applies `kind` / `scope` / `tags` / `since` filters in SQL; default excludes ephemeral scopes.
  - `searchEvents(db, embedder, query, opts)` — same pattern on the events surface.
  - `searchEntities(db, embedder, query, opts)` — same on entities.
  - `listMemos(db, opts)` — index-backed list (no embedding).
  - `neighbors(db, recordId, kind, opts)` — bidirectional via the `IF from=$e THEN to ELSE from END` pattern.

- [ ] Unit test `tests/unit/store-search.test.js`: indexed paths, scope default exclude, neighbors symmetry.

**Commit:** `feat(memory): store.js read primitives`

### Task 1.9 — Audit registry coverage

- [ ] Test `tests/unit/audit-registry-coverage.test.js`: greps `src/` for `kind:` string literals; asserts every memo kind is in `MEMO_KIND_REGISTRY` and every edge kind is in `EDGE_KIND_REGISTRY`.

**Commit:** `test(audit): registry coverage on memo + edge kinds`

---

## Wave 2 — Faculty lenses

Each lens is a thin file (~30–60 LOC) that re-exports `store.js` primitives with kind-baked-in. Old `hot/journal/knowledge/patterns/profile/threads.js` deleted at end of wave.

### Task 2.1 — `src/memory/attention.js`

- [ ] Replaces `hot.js`. Same `getAttention(db, { source?, windowMinutes? })` API plus entity enrichment (today's hardcoded `entities: []` becomes a `mentions`-edge fanout over active episodes).
- [ ] Rename test file `tests/unit/hot.test.js` → `tests/unit/attention.test.js`, update to new module path, add entity-enrichment assertion.

**Commit:** `feat(memory): attention.js (was hot.js) + entity enrichment`

### Task 2.2 — `src/memory/chronicle.js`

- [ ] Replaces `journal.js`. Same `listChronicleEntries` API (renamed from `listJournalEntries`). Filters unchanged.
- [ ] Rename test `tests/unit/journal.test.js` → `tests/unit/chronicle.test.js`.

**Commit:** `feat(memory): chronicle.js (was journal.js)`

### Task 2.3 — `src/memory/knowledge.js` (kept name, refactored)

- [ ] Becomes a thin lens: `add` / `search` / `list` → `store.note('knowledge', …)` / `searchMemos({kind:'knowledge'})` / `listMemos({kind:'knowledge'})`.
- [ ] Update `tests/unit/knowledge.test.js` for new internals; same public surface.

**Commit:** `refactor(memory): knowledge.js → lens over store`

### Task 2.4 — `src/memory/habits.js`

- [ ] Replaces `patterns.js`. `upsert` / `list` → `store.upsertMemoByName('habit', …)` / `listMemos({kind:'habit'})`.
- [ ] Rename test `tests/unit/patterns.test.js` → `tests/unit/habits.test.js`.

**Commit:** `feat(memory): habits.js (was patterns.js)`

### Task 2.5 — `src/memory/persona.js`

- [ ] Replaces `profile.js`. Same `getPersona` / `updatePersonaFields` API (renamed from `getProfile` / `updateProfileFields`). Singleton at `persona:singleton`.
- [ ] Adds `updateCommStyle(db, fields)` and `updateCalibration(db, fields)` helpers used by dream steps.
- [ ] Rename test `tests/unit/profile.test.js` → `tests/unit/persona.test.js`.

**Commit:** `feat(memory): persona.js (was profile.js)`

### Task 2.6 — `src/memory/narrative.js`

- [ ] Replaces `threads.js`. `add` / `list` → `store.note('thread', { meta:{title,summary,episode_ids,entity_ids} })`.
- [ ] Rename test `tests/unit/threads.test.js` → `tests/unit/narrative.test.js`.

**Commit:** `feat(memory): narrative.js (was threads.js)`

### Task 2.7 — `src/memory/foresight.js`

- [ ] Consolidates predictions code from CLI handlers. `predict` / `resolve` / `listOpen` / `computeCalibration` all routed through `store.note('prediction', …)` / `store.updateMemoMeta` / `store.listMemos({kind:'prediction'})`.
- [ ] Move pure logic from `src/cli/commands/predictions.js` here; CLI command becomes a thin wrapper.
- [ ] Test `tests/unit/foresight.test.js`.

**Commit:** `feat(memory): foresight.js (consolidates predictions)`

### Task 2.8 — Delete old memory modules

- [ ] `git rm src/memory/hot.js src/memory/journal.js src/memory/patterns.js src/memory/profile.js src/memory/threads.js`.
- [ ] Grep for imports of those paths anywhere in repo; update or verify each.

**Commit:** `chore(memory): delete renamed/replaced modules`

---

## Wave 3 — Capture rewrites + cascade

The capture path moves to `store.remember` / `store.note` / `store.relateAll`. The old `src/graph/cascade.js` is deleted (replaced by DEFINE EVENT triggers in the schema).

### Task 3.1 — `src/capture/record-event.js` routing

- [ ] Replace internal INSERT with `store.remember(db, embedder, {...})`. Pass through new fields: `trust`, `scope`, `tags`, `attachments`.
- [ ] Update `tests/unit/record-event.test.js` / `tests/integration/recall-on-recorded-event.test.js` if any references exist.

**Commit:** `refactor(capture): record-event uses store.remember`

### Task 3.2 — `src/capture/biographer.js` + `biographer-output.js`

- [ ] Replace per-edge-table UPSERTs with `store.relateAll([...])` batched edges (`mentions`, `about`, `before`, `works_on`, `participates_in`, `occurs_with`).
- [ ] Emit `derived_from` edges from any memo the biographer writes back to source events.
- [ ] Counter-edge `occurs_with` uses the registry's `counter: true` path automatically.
- [ ] Update biographer integration test fixtures (`tests/integration/biographer-*.test.js`).

**Commit:** `refactor(biographer): emit edges via store.relateAll; derived_from provenance`

### Task 3.3 — `src/capture/ingest` (knowledge emission)

- [ ] Replace direct knowledge INSERTs with `store.note('knowledge', {...})`. Attachments preserved for url/file source.
- [ ] Update `tests/integration/knowledge-ops-ingest.test.js`.

**Commit:** `refactor(ingest): knowledge emission via store.note`

### Task 3.4 — `src/outbound/policy.js` — action_outcome events

- [ ] After tool resolution, emit `store.remember(db, e, { source:'action_outcome', content:`${tool}:${action} → ok=${ok}`, trust:'derived', scope, meta:{tool, action, ok, ms, error?} })`.
- [ ] Fail-soft if recall daemon unavailable.
- [ ] Test `tests/unit/outbound-action-outcome.test.js`.

**Commit:** `feat(outbound): emit action_outcome events on tool resolution`

### Task 3.5 — Delete `src/graph/cascade.js`

- [ ] `git rm src/graph/cascade.js`.
- [ ] Adjust `src/graph/edges.js` to become a thin wrapper over `store.relate` (or delete if nothing else uses it).
- [ ] Grep for cascade.js imports; remove.

**Commit:** `chore(graph): drop cascade.js (replaced by DEFINE EVENT triggers)`

### Task 3.6 — Cascade integration test

- [ ] `tests/integration/edge-cascade.test.js`: create an entity with attached `mentions` edges, DELETE the entity, assert edges gone in the same transaction. ROLLBACK the deletion; assert edges still present.

**Commit:** `test(integration): edge cascade fires inside delete transaction`

---

## Wave 4 — Recall + dream + reinforcement

The biggest behavior changes. After this wave, recall ranking blends freshness × cosine × contradiction × trust × scope.

### Task 4.1 — `src/recall/rank.js`

- [ ] Implement `score(hit, query)` per spec §7.2. Components: `cosine`, `freshness`, `contradiction_penalty`, `trust_factor`, `scope_boost`. Returns `{ score, components }`.
- [ ] Export `MMRLite(hits, threshold = 0.92)` for diversity pass.
- [ ] Unit tests cover component composition + MMR suppression.

**Commit:** `feat(recall): rank.js (cosine × freshness × contradiction × trust × scope) + MMR-lite`

### Task 4.2 — `src/recall/index.js`

- [ ] Replace direct HNSW query with `store.searchEvents` / `store.searchMemos` calls; apply `rank.score`; MMR-lite; write `recall_log` row with `outcome='pending'`.
- [ ] Return shape preserves backward compatibility (`{ hits }` array).

**Commit:** `refactor(recall): index.js queries embeddings tables; ranks via rank.js; logs to recall_log`

### Task 4.3 — `src/recall/intuition.js`

- [ ] Same routing as recall/index plus contradiction annotations in the formatted `<!-- relevant memory -->` block.
- [ ] `intuition_telemetry` table writes preserved.

**Commit:** `refactor(intuition): contradiction annotations + rank.score in injected block`

### Task 4.4 — `src/recall/reinforcement.js`

- [ ] Implement the heartbeat-driven evaluator: walks `recall_log` rows where `outcome='pending' AND ts < now - 5min`; checks for `meta.kind='correction'` events in the same session within `[ts, ts+5min]`; reinforces hits or marks corrected.
- [ ] Idempotent: only evaluates `outcome='pending'`.

**Commit:** `feat(recall): reinforcement loop (signal_count++ when recall + no correction)`

### Task 4.5 — `src/jobs/internal/reinforce-recall.js` + builtin job

- [ ] Internal job runtime entry point calling `reinforcement.evaluatePending(db, embedder)`.
- [ ] `src/jobs/builtin/reinforce-recall.md` — frontmatter (`schedule: */5 * * * *`, `runtime: internal`, `manually_runnable: true`, body explains).

**Commit:** `feat(jobs): reinforce-recall internal job (5-min cadence)`

### Task 4.6 — Dream step renames

- [ ] `git mv src/dream/step-patterns.js src/dream/step-habits.js`; update internal references to `habits.upsert` instead of `patterns.upsert`.
- [ ] `git mv src/dream/step-threads.js src/dream/step-narrative.js`; update internal references to `narrative.add`.
- [ ] Update `src/dream/pipeline.js` step names + imports.
- [ ] Update tests that reference these file names.

**Commit:** `refactor(dream): step-patterns→step-habits, step-threads→step-narrative`

### Task 4.7 — `src/dream/step-knowledge.js` — emit supersedes

- [ ] When the LLM-driven promotion identifies a new knowledge memo that contradicts an existing one with higher confidence, call `store.supersede(oldId, newId)` after creating the new memo. Old memo preserved.
- [ ] Unit test covers the supersede path.

**Commit:** `feat(dream): step-knowledge emits supersedes on contradicting promotion`

### Task 4.8 — `src/dream/step-scope-cleanup.js`

- [ ] New step at end of dream pipeline: walks `memos WHERE scope LIKE 'session:%' OR scope LIKE 'temp:%'`.
- [ ] For each, checks for inbound `derived_from` edges from non-ephemeral memos; if any → promote scope to `'global'`.
- [ ] Then deletes remaining ephemerals older than threshold (session: 7d, temp: 24h).
- [ ] Update `pipeline.js` to include the step.

**Commit:** `feat(dream): step-scope-cleanup promotes referenced ephemerals, prunes the rest`

### Task 4.9 — `src/dream/step-comm-style.js` + step-calibration

- [ ] Call sites: `profile.updateProfileFields` → `persona.updatePersonaFields` (or the dedicated helpers from Task 2.5).
- [ ] step-comm-style: when tone shift detected > threshold, also emit a `kind='state_inference'` memo via `store.note('state_inference', {...})`.

**Commit:** `refactor(dream): step-comm-style + step-calibration use persona; state_inference emission`

### Task 4.10 — `src/dream/step-reflection.js` — positive clusters too

- [ ] In addition to correction clusters (today), also cluster the inverse: reinforcement events (recall_log rows with `outcome='reinforced'` clusterable by query embedding). For ≥3-event clusters, emit `rule_candidates` with `kind='reinforce_behavior'`.

**Commit:** `feat(reflection): positive-reinforcement clusters generate rule_candidates`

---

## Wave 5 — MCP + CLI surface

Surface-level changes only; behavior already migrated in Wave 4.

### Task 5.1 — MCP tool handlers

- [ ] `src/mcp/tool-handlers/*.js`: route through new modules. Tools affected: `recall`, `remember`, `find_entity`, `ingest`, `predict`, `resolve_prediction`, `list_open_predictions`, `lint`, `audit`, `update_action_policy`, `check_action`, `get_comm_style`, `run_dream`.
- [ ] Tool schemas (JSON) unchanged externally. Add `scope` / `tags` / `attachments` accepted on `remember` and `ingest`.

**Commit:** `refactor(mcp): tool handlers route through new memory + recall surface`

### Task 5.2 — CLI command rewrites

- [ ] `src/cli/commands/predictions.js` — thin wrapper over `foresight.js`.
- [ ] `src/cli/commands/lint.js` — query the single `edges` table; query `memos` (not the old per-kind tables).
- [ ] `src/cli/commands/audit.js` — same.

**Commit:** `refactor(cli): predictions/lint/audit consume new schema`

---

## Wave 6 — Embedder lifecycle

### Task 6.1 — `src/cli/commands/embeddings.js`

- [ ] Subcommands: `prepare <profile>`, `backfill <profile>`, `dual-read --on/--off [--profile]`, `activate <profile>`, `list`, `drop <profile>`.
- [ ] `prepare` — DDL: `DEFINE TABLE embeddings_<profile>_events|memos|entities ...` with the profile's dim (lookup from `src/embed/profiles.js`).
- [ ] `activate` — atomic UPDATE of `runtime:embedder`.
- [ ] `drop` — DROP the three tables for that profile after a confirmation prompt (refuses if currently active or in read window).

**Commit:** `feat(cli): robin embeddings prepare/backfill/dual-read/activate/list/drop`

### Task 6.2 — `src/jobs/internal/embeddings-backfill.js`

- [ ] Resumable batched backfill: 200 rows per chunk, advances `runtime:embedder_backfill.value.cursors.<surface>.last_processed_id`. Reads/writes cursor row each chunk.
- [ ] On completion (all surfaces drained), DELETE the `runtime:embedder_backfill` row.
- [ ] CLI command invokes via `daemon-request` (single-writer property preserved).

**Commit:** `feat(jobs): embeddings-backfill (resumable, cursor-tracked)`

### Task 6.3 — `src/embed/factory.js` + `src/embed/backfill.js`

- [ ] `factory.js` consults `profile-router.activeProfile()` and `readProfile()`; constructs the right embedder client.
- [ ] Existing `backfill.js` either deleted (superseded by Wave 6.2 internal job) or repurposed — likely deleted.

**Commit:** `refactor(embed): factory honors profile-router; old backfill.js retired`

---

## Wave 7 — Tests, docs, audit, cleanup

### Task 7.1 — Audit grep tests

- [ ] `tests/unit/audit-no-old-table-names.test.js`: greps `src/` and `tests/` for forbidden literals (`knowledge` (as table), `patterns` (as table), `threads` (as table), `predictions` (as table), `co_occurs_with`, `precedes`, `runtime_intuition_telemetry`, `recall_events`, `profile:singleton`). Allowed exceptions: spec/plan docs, CHANGELOG. Asserts no production source contains them.

**Commit:** `test(audit): forbid old table names in production source`

### Task 7.2 — Integration test sweep

- [ ] Walk `tests/integration/`; for each test that uses old table names or memory modules, update to the new ones. Expect ~15–25 files.
- [ ] Run full integration suite (excluding the known-hanging `biographer-process-pending-captures.test.js`).
- [ ] Track failures; fix one at a time.

**Commit:** `test(integration): update suite for new schema + memory layer`

### Task 7.3 — Doc rewrites

- [ ] `docs/architecture.md`: rewrite top-level diagram, table list, example queries to match new shape.
- [ ] `docs/faculties.md`: update module names (attention/chronicle/habits/persona/narrative/foresight + knowledge); add the "module-vs-kind naming convention" section.
- [ ] `docs/development.md`: update guidance for adding new memo kinds (validator + lens, no migration), new edge kinds (registry entry only), new integrations (capture surface defaults).
- [ ] `docs/troubleshooting.md`: table name updates.
- [ ] `AGENTS.md` blocks: regenerate where they reference table names.
- [ ] `README.md`: alpha version bump; one-line note about the redesign.
- [ ] `CHANGELOG.md`: new entry describing the redesign with the headline bullets.

**Commit:** `docs: rewrite architecture/faculties/development/troubleshooting for v2-redesign`

### Task 7.4 — `src/migrate-v1/README.md`

- [ ] Add a top-level note: "**STALE.** This migrator targets the v1 schema and the *pre-redesign* v2 schema. It needs a rewrite before another migration is attempted. See spec at `docs/superpowers/specs/2026-05-11-…`."

**Commit:** `docs(migrate-v1): mark stale pending rewrite`

### Task 7.5 — Lint clean + final test sweep

- [ ] `npm run lint` — zero errors.
- [ ] Full unit suite: `node --test --test-force-exit 'tests/unit/**/*.test.js'`. Expect pass-rate ≥ baseline (1067 pre-existing), accounting for renames.
- [ ] Full integration suite (excluding hanging biographer test). All pass.

**Commit:** `chore: lint clean post-redesign`

### Task 7.6 — Status snapshot for handoff

- [ ] Write `HANDOFF.md` at repo root (overwrite previous): wave-by-wave summary, file counts, test pass-rate, anything deferred, rollout notes (`robin install` → daemon restart suffices since DB will be re-init'd).

**Commit:** `docs: handoff summary for db + memory redesign branch`

---

## Acceptance criteria (whole plan)

- All 14 old migration files deleted; one new `0001-init.surql` present.
- `src/memory/` contains the seven new lenses + store/decay/registries/scopes; old five `hot/journal/patterns/profile/threads.js` gone.
- `src/graph/cascade.js` gone; cascade behavior provided by `DEFINE EVENT` triggers in the schema.
- Verification gate script `scripts/verify-design-assumptions.js` exists and runs green.
- Per-surface, per-profile embedding tables exist for the active profile (default `gemini_3072`); recall + intuition query them.
- Recall reinforcement loop runs as a built-in internal job; `recall_log.outcome` transitions verified by integration test.
- `supersede` + `flagContradiction` paths covered by unit tests; `fn::freshness` returns 0 for superseded memos.
- Capture surfaces emit `trust`, `scope`, `tags`, `attachments` where the spec calls for them; `action_outcome` events generated by outbound discretion.
- Lint clean. Unit + integration suites green (modulo the known-hanging biographer test).
- Docs rewritten; `HANDOFF.md` summarizes outcome.
