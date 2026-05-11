# SurrealDB Improvements — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-11-surrealdb-improvements-design.md`
**Date:** 2026-05-11
**Mode:** Autonomous execution (user directive).

## Sequencing principle

Additive schema first → big breaking schema rewrite next → batching → hybrid retrieval. Commit at each phase boundary.

## Phase 1 — Additive foundations

Schema-additive; no edges-table changes yet. Safe to ship independently.

### P1.1 Schema additions
- [ ] Edit `src/schema/migrations/0001-init.surql`:
  - Define `english` analyzer + `events_content_fts`, `memos_content_fts`, `entities_name_fts` FULLTEXT indexes.
  - Add `events_meta_kind` field-path index on `meta.kind`.
  - Add `runtime_jobs.is_overdue` COMPUTED field.
  - Add `REFERENCE` clauses to `events.episode_id` (`ON DELETE UNSET`), `rule_candidates.signal_events` (`ON DELETE IGNORE`), `rules.source_candidate` (`ON DELETE IGNORE`).
  - Add `member_events COMPUTED <~events` on `episodes`.
  - Seed `runtime:recall.config` with default tuning row.

### P1.2 Engine swap
- [ ] Edit `src/db/client.js` to read `db.engine` from `<robinHome>/config.json` (fall back to `'mem://'` for tests).
- [ ] Edit `src/runtime/config.js` to expose `db.engine`.
- [ ] Update `src/install/*` to write `db.engine = 'surrealkv+versioned'` on fresh installs.
- [ ] Add `robin doctor` check for engine match.

### P1.3 Verification gates 14-18
- [ ] Extend `scripts/verify-design-assumptions.js` with five new gates.

### P1.4 Commit
- [ ] One commit: `feat(db): phase 1 — additive foundations (engine, REFERENCE, COMPUTED, FULLTEXT)`.

## Phase 2 — Edges TYPE RELATION + arrow refactor

The keystone correction. Highest blast radius.

### P2.1 Schema rewrite
- [ ] Edit `src/schema/migrations/0001-init.surql`:
  - Change `DEFINE TABLE edges` to `TYPE RELATION` (no FROM/TO clause).
  - Rename `from`/`to` fields → `in`/`out`.
  - Update `edges_kind_in` / `edges_kind_out` index definitions.
  - Update cascade-event triggers to reference `in`/`out`.
  - Update `fn::freshness` body (subquery on `to` → `out`).

### P2.2 Memory core rename
- [ ] `src/memory/edge-registry.js`: rename `EDGE_KIND_REGISTRY` keys; update `canonicalEndpoints`/`compositeEdgeId`/validation helpers.
- [ ] `src/memory/store.js`: rename in all UPSERT SQL bodies (`relate`, `relateAll`), arrow refactor in `getMemo` + `neighbors`, update `_surfaceSearch` filter SQL.
- [ ] `src/memory/attention.js`: arrow projection for the `mentions`/`about` edge sweep.
- [ ] `src/memory/decay.js`: `fn::freshness` mirror — no field references but verify.
- [ ] `src/memory/knowledge.js`: `IN (SELECT VALUE from FROM edges ...)` → arrow form.

### P2.3 Dream + recall refactor
- [ ] `src/dream/step-knowledge.js`: arrow form for knowledge memo lookup + mention counts.
- [ ] `src/dream/step-patterns.js`: name hydration via `in.name`/`out.name` projection.
- [ ] `src/dream/step-threads.js`: mentions traversal → arrow form.
- [ ] `src/dream/step-scope-cleanup.js`: edge sweep simplification.
- [ ] `src/recall/reinforcement.js`: converge `hit.memo_id ?? hit.event_id ?? hit.record_id ?? hit.record` to `hit.record`.
- [ ] `src/recall/intuition.js`: emit hits with unified `record` field, plus `_sources`.

### P2.4 MCP tools + jobs refactor
- [ ] `src/mcp/tools/recall.js`: strip `_sources` from agent payload; keep in `recall_log`.
- [ ] `src/mcp/tools/get-entity.js`: arrow form; add `path_to` argument (optional, `+shortest`).
- [ ] `src/mcp/tools/related-entities.js`: arrow form; add `depth` argument (1-3).
- [ ] `src/mcp/tools/ingest.js`, `find-entity.js`, `lint.js`, `audit.js`: field rename.
- [ ] `src/jobs/{ingest-prompt,lint-checks}.js`, `src/jobs/internal/reinforce-recall.js`: field rename.
- [ ] `src/cli/commands/ingest.js`: field rename.

### P2.5 Biographer
- [ ] `src/capture/biographer.js`, `biographer-output.js`, `biographer-prompt.js`: emit edges via `store.relateAll` (already routes through, but verify field-rename consistency).

### P2.6 Graph wrapper
- [ ] `src/graph/edges.js`: thin wrapper update.

### P2.7 Test rewrites
- [ ] `tests/unit/edges-cooccur.test.js`, `tests/unit/edges-mentions.test.js`: field-name + arrow assertions.
- [ ] `tests/unit/lint-checks.test.js`: field rename.
- [ ] `tests/integration/biographer-pipeline.test.js`: field rename.
- [ ] `tests/unit/audit-no-old-tables.test.js`: extend with `from edges`/`to edges` literal-string tripwires.

### P2.8 Verification gates 5-7
- [ ] Add Gate 5 (EXPLAIN FULL on arrow traversal uses `edges_kind_in`).
- [ ] Add Gate 6 (recursive `{1..3}->edges[WHERE kind=...]->...` returns expected nodes).
- [ ] Add Gate 7 (composite-ID UPSERT counter idempotent on RELATION).

### P2.9 Commit
- [ ] One commit: `feat(db): phase 2 — edges TYPE RELATION + arrow traversal`.

## Phase 3 — Hot-path batching

### P3.1 `relateAll` multi-statement BEGIN/COMMIT
- [ ] Rewrite `store.relateAll` to build chunked multi-statement queries with `.responses()`.

### P3.2 `getMemo` 4 → 1
- [ ] Rewrite `store.getMemo` to use the single LET-block query.

### P3.3 `evaluatePending` bucket-by-count
- [ ] Rewrite `src/recall/reinforcement.js`:
  - One pre-fetch for correction events in union window.
  - Group reinforcements by hit-count, one UPDATE per distinct count.
  - One UPDATE per outcome bucket on `recall_log`.

### P3.4 `_surfaceSearch` two-stmt one-round-trip
- [ ] Rewrite `store._surfaceSearch` kNN+hydration combine.

### P3.5 Capture path collapse
- [ ] Rewrite `store.remember` and `store.note` for dedup+create+embed in one multi-statement query.

### P3.6 Verification gates 9-13
- [ ] Add Gate 9 (`relateAll(20)` < 50ms).
- [ ] Add Gate 10 (`getMemo` shape regression).
- [ ] Add Gate 11 (`evaluatePending(50 × 6)` < 150ms).
- [ ] Add Gate 12 (same memo in 3 pending rows → `signal_count` += 3).
- [ ] Add Gate 13 (`remember()` ≤ 1 DB round-trip).

### P3.7 Commit
- [ ] One commit: `perf(db): phase 3 — hot-path batching (relateAll, getMemo, evaluatePending, capture)`.

## Phase 4 — Hybrid retrieval

### P4.1 Recall config row
- [ ] Seed `runtime:recall.config` (done in Phase 1 schema, but verify the row exists at boot).

### P4.2 BM25 retrieval
- [ ] Add `_bm25Retrieve` helper to `src/memory/store.js`.

### P4.3 RRF fuser + distance padding
- [ ] Add `src/recall/fusion.js` with `rrfFuse` and `padDistances`.

### P4.4 `_surfaceSearch` rewrite
- [ ] Replace `_surfaceSearch` body with parallel kNN + BM25 + RRF + MMR-lite pipeline.
- [ ] Adaptive over-fetch driven by `runtime:recall.config`.

### P4.5 Telemetry
- [ ] Extend `intuition_telemetry` writes to include `knn_n`, `bm25_n`, `fused_n`, `bm25_only_in_top_k`, `filter_count`, `knnK_used`.

### P4.6 Bench harness
- [ ] Write `scripts/bench-recall.mjs`:
  - Seed `tests/fixtures/recall-golden.json` with ~30 query→expected-hit pairs (bootstrap by combining existing test fixtures + a few hand-authored cases).
  - Run hybrid + vector-only, report recall@10 and p95 latency.

### P4.7 Verification gate 8
- [ ] Add Gate 8 (post-filter shrinkage with adaptive over-fetch: `filterCount=2 + limit=10` returns ≥7 final results 95% of the time on fixture).

### P4.8 Commit
- [ ] One commit: `feat(recall): phase 4 — hybrid BM25 + vector + RRF`.

## Phase 5 — Verify, docs, final commit

### P5.1 Run everything
- [ ] `node scripts/verify-design-assumptions.js` — all 18 gates green.
- [ ] `node scripts/verify-hnsw-plan.mjs` — extended for arrow plans.
- [ ] `node scripts/bench-recall.mjs` — record lift number.
- [ ] `node scripts/test-store-smoke.mjs`.
- [ ] `node scripts/test-reinforcement-smoke.mjs`.
- [ ] `node scripts/test-intuition-loop-smoke.mjs`.
- [ ] `npm run test:unit`.
- [ ] `npm run test:integration`.
- [ ] `npm run lint`.

### P5.2 Docs
- [ ] `docs/architecture.md` — rewrite the "graph-arrow traversal is unavailable" paragraph; add arrow-traversal section.
- [ ] `docs/faculties.md` — hybrid retrieval section under recall.
- [ ] `docs/development.md` — version-reads vs supersedes section.
- [ ] `docs/troubleshooting.md` — engine-mismatch + checksum-mismatch failure modes.
- [ ] `HANDOFF.md` — rollout addendum headlined with checksum constraint.
- [ ] `CHANGELOG.md` — 6.0.0-alpha.15 entry.

### P5.3 Final commit
- [ ] One commit: `docs(db): phase 5 — verification + documentation updates`.
