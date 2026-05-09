# Changelog

## [6.0.0-alpha.0] — 2026-05-09

Phase 1 foundation. The minimum SurrealDB-first vertical slice:

- New repo, new package version line.
- Embedded SurrealDB v3 via `@surrealdb/node` (rocksdb:// engine; mem:// in tests).
- Schema source-of-truth in `src/schema/migrations/*.surql` with a v3-aware migration runner.
- `events` table (with HNSW vector index pinned to dimension 384) + `runtime` + `_migrations` schemas.
- Embedder pipeline (`@huggingface/transformers`, lazy-loaded; deterministic stub for tests). Default model: `Xenova/bge-small-en-v1.5` (chosen by Phase 1 benchmark).
- Internal `recordEvent` and `recall` functions with content-hash embedding cache.
- CLI surface: `robin migrate`, `robin --version`, `robin --help`. No agent-facing commands yet (deferred to Phase 3 MCP server).
- ROBIN_HOME bootstrap, cooperative file lock, pre-migration tar backup.
- CI: GitHub Actions workflow for unit + integration on ubuntu-latest and macos-latest, plus schema-lint. Activates when v2 merges back into the GitHub-hosted v1 repo.
- Embedder benchmark methodology + chosen model pinned (see `docs/superpowers/specs/2026-05-09-robin-v2-embedder-benchmark.md` in the v1 repo).
- `scripts/dev-recall.js` for manual smoke testing.

No agent integration yet. v1 (`robin-assistant@5.x`) remains daily-use Robin.
