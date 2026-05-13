# Changelog

## Unreleased

### Integrations

- **`photos` integration.** Apple Photos surface — captures recent imports from the local Photos library into Robin's memory. New MCP tool `photos_recent`; default cadence `6h`. Source directory is `PHOTO_COLLECTION_DIR` (defaults to `~/Photography/Collection`).
- **`finance_quote` per-holding sync.** `FINANCE_QUOTE_TICKERS` env var now drives per-ticker fetches (one event per holding per tick) so holdings can be queried independently rather than as a single conflated quote.

### `user-data/` folder redesign — faculty-aligned layout (v2)

The `<robin_home>/user-data/` tree was a flat sprawl of seventeen entries at the root (six loose files mixed with eleven directories, ad-hoc nesting like `runtime/state/`, `cache/logs/` mixing append-only logs with diagnostic reports and snapshots, an empty `backup/`, redundant `skills/external/`). Hard to predict where any file lived; harder to know whether you could touch it. New layout mirrors `system/`'s realm split (cognition · io · data · runtime), keeps every user-touchable surface at the root, and tucks the four faculty realms below.

- **Root surface** (10 entries, down from 17): user-content directories (`artifacts/`, `jobs/`, `skills/`, `sources/`, `upload/`), `config/` (now folds `secrets/` into `config/secrets/`), and the four faculty realms `cognition/`, `io/`, `data/`, `runtime/`. No more loose JSON files or dotfiles at the root.
- **Path moves**: `db/` → `data/db/`; `secrets/.env` → `config/secrets/.env`; `cache/logs/*` → `runtime/logs/*`; `cache/v1-import-report-*.json` → `runtime/install/reports/`; `cache/sqlite-snapshots/` → `io/sqlite-snapshots/` (distinct from `data/snapshots/` for Robin-DB backups); `runtime/state/published/index.jsonl` → `io/publish/index.jsonl`; `runtime/state/telemetry/publish.log` → `runtime/logs/publish.log`; `runtime/state/daemon-status.json` → `runtime/daemon/status.json`; `runtime/state/recall-reinforce-last-run.json` → `cognition/reinforcement-last-run.json`; root JSONs (`config.json`, `manifest.json`, `host-integrations.json`) and dotfiles (`.daemon.{pid,state,lock}`, `.manifest.lock`, `.robin-data`) into the appropriate realm sub-dirs; `skills/external/*` collapsed to `skills/*`.
- **Single source of truth**: `paths.data.*` in `system/config/data-store.js` is the only place hardcoded paths live. Removed accessors `cache()` and `backup()` (callers updated). Added `snapshots()`, `installReports()`, `sqliteSnapshots()`, `daemonStatus()`, `manifest()`, `publishIndex()`, `reinforcementLastRun()`, `artifacts()`, `jobs()`, `skills()`, `sources()`. Renamed marker to `runtime/install/.marker.json` with `user_data_layout_version: 2`.
- **One-shot migrator (`system/runtime/install/layout-migrator.js`)**: invoked from `ensureHome()` so every CLI command, hook, and daemon-boot path triggers it as a marker-gated no-op once at v2. Detects layout version by probing both old (`<home>/.robin-data`) and new marker locations, returning `'v2' | 'v1' | 'fresh'`. v1→v2 transition refuses to run when the daemon is alive (PID-alive check on `.daemon.pid`, both at old root and new `runtime/daemon/.pid`) — a live RocksDB handle through a `rename db → data/db` would corrupt the store. PID-encoded lockfile (`<home>/.layout-migrator.lock`) prevents concurrent migrations; stale locks (dead PID) are stolen. Each rename is idempotent: completed steps are skipped on re-entry, and the rare "both source and target non-empty" state aborts with a typed `LAYOUT_MIGRATOR_CONFLICT` for manual resolution. Atomic via `rename(2)` (intra-filesystem only — matches the install-time invariant).
- **`robin migrate-user-data` CLI**: exposes the migrator with `--dry-run` (prints the planned moves) and `--verbose` (per-rename trace). Normal invocations don't need it — any `robin` command will trigger the migration on the next run.
- **Doctor `Layout` section**: reports the marker version and lists stray legacy dirs (`cache/`, `backup/`, `runtime/state/`, `skills/external/`, `sources/media/`). Surfaces partial/pending migrations without auto-cleaning. Exit-code semantics specified for v2/v1/missing states.
- **Callers updated end-to-end**: `migrate.js` (snapshot dest), `import-v1.js` (report dest), `lrc/sync.js` + `chrome/sync.js` (sqlite-snapshot cache), `migrate-fresh.mjs` (db + backup paths), `publish.js` + `published.js` (index/telemetry paths), `publish/config.js` (logPath/telemetryPath converted to function exports), `manifest.js`, `postinstall.js` (marker probe accepts old OR new), `migrate-home.js` (verification probe accepts both), `install.js` (`hasMarker` helper for either-location probes, v2-storage-shape legacy detection), `agents-md.js` (security-posture path text), `launchd-plist.js` + `systemd-unit.js` (log path), plus comment-only updates in `daemon/server.js`, `daemon/http.js`, `daemon/mcp-sse.js`, `mcp-install.js`, `mcp-start.js`, `discretion/bash-patterns.js`, `lrc/client.js`. `discoverExistingHomes` now probes both marker locations and both v1/v2 storage shapes.
- **Tests**: 15 new layout-migrator tests covering version detection across all three states, full populated-v1 migration with file-content preservation assertions, idempotency, dry-run, daemon-running refusal, stale-lockfile recovery, both-non-empty conflict, partial-resume; 3 new ensure-home-end-to-end tests. ~28 existing test files updated for new path expectations (config/config.json, config/secrets/.env, data/db, runtime/logs/, runtime/daemon/.state, runtime/install/manifest.json, etc.). Full unit suite green (1512/1512); integration green except for 12 pre-existing telemetry-rollup failures that pre-date this refactor and don't touch any moved path.

Design spec: `docs/superpowers/specs/2026-05-12-user-data-folder-redesign-design.md`.

### `secrets set` — accept `KEY VALUE`, validate key shape before prompting

Two UX bugs in `robin secrets set` reported from real use:

- **Silent argv-drop.** Handler in `secrets-set.js` only read `argv[0]`, so the natural form `robin secrets set GEMINI_API_KEY <value>` (two positional args) silently discarded the value and dropped the user into the interactive prompt with no explanation. Now: two-arg form is accepted (same shell-history warning as `KEY=VALUE`), and `>2` positional args exits with usage instead of swallowing extras.
- **Post-prompt key validation.** The `ENV_KEY_RE` check lived only inside `saveSecret`, so a misuse like `robin secrets set AIzaSy-not-a-key` (forgot the env var name) made the user type a hidden value at the prompt before being told the *key* was malformed. `ENV_KEY_RE` + new `assertValidKey` are now exported from `config/secrets.js` and the CLI validates the key shape before any prompt — invalid keys fail instantly.

Tests: new `secrets-cli-set.test.js` covering `KEY=VAL`, `KEY VAL`, no-args usage, too-many-args usage, and pre-prompt key-shape rejection (5 tests). Existing `assertValidSecret` path unchanged.

### v1 import — close the remaining data-loss gaps

A full audit of the v1→v2 migrator against Kevin's actual v1 user-data surfaced five concrete losses that this round fixes. Before: ~270 timestamped entries collapsed into 2 mtime-based events; ~13 active `self-improvement/` and root files weren't imported at all; a live working artifact (`cali-trip-2026-packing-list.md`) sat outside the copied paths; the on-disk `_v1_imports` ledger correctly tracked everything, but report-level visibility into per-source breakdowns was dead.

- **`streams/inbox.md` (248 dated entries) + `streams/log.md` ([YYYY-MM-DD] headers).** The dated-header regex in `parsers/dated-entries.js` only matched `## YYYY-MM-DD` or `## YYYY-MM-DD — title`; everything else fell through `passEvents`' empty-entries branch and produced a single mtime-anchored event per file. New regex `^(##|###)\s+\[?(\d{4}-\d{2}-\d{2})\]?(.*)$` plus a `cleanTitle` helper strips em-dash / pipe separators left over from the various v1 shapes. `passes/d-events.js` keys inbox/log sourcePaths off the header line number so same-day entries don't collide on `content_hash`. After fix: 247 inbox events + 4 log events (was 1 + 1).
- **`self-improvement/{communication-style,threads,domain-confidence,learning-queue,session-handoff}.md`.** None were imported. Pass B now routes `communication-style.md` through `applyFacet` (the existing `commStyleProjector` in `taxonomy.js` was already wired but no caller invoked it) and creates `memos(kind='pattern' | 'knowledge', meta.source=<slug>)` for the others. Long bodies (`threads.md`, `learning-queue.md`) chunk via the existing `writeChunkedMemo` path.
- **`memory/tasks.md`.** Previously skipped as a "view" file, but its open `[ ]` items (HSA top-ups, Prudential V9043863 follow-ups, MS beneficiary, ELCAP CT, dermatology, BofA close-out, project work) aren't derivable from anywhere else. Removed from `SKIPPED_VIEW_FILES`; imported as `kind='knowledge', meta.source='v1-tasks'` (chunked when long).
- **`memory.surrealdb-era/**`.** Historical photo-collection audit/proposals/scans, frozen from a prior schema era. Spec said skip; reality is they're 11 markdown records not duplicated elsewhere. Pass B now walks `memoryDir/../memory.surrealdb-era/` and imports each as low-confidence (`0.3`) `knowledge` memos with `meta.archived=true, meta.source='memory.surrealdb-era'`.
- **`user-data/artifacts/*.md`.** Live working docs (the cali-trip-2026-packing-list ahead of the 5/14 flight). Extended `passSources` with a generic `copyTree` helper so it now mirrors both `sources/` (all files) and `artifacts/` (`.md` only) into v2's `user-data/`, recording one `_v1_imports(kind='source_file')` row per file.
- **Reporting bugs.** `report.breakdown_events` was initialised but never incremented (`bumpCounts` now updates it); `report.breakdown_edges.about` was double-counting `derived_from` edges because `passMemos` lumped both into a single `counts.edges`. Pass B now tracks `about_edges` and `derived_from_edges` separately and `index.js` writes them to the right buckets.

Live import deltas against Kevin's v1 user-data (gemini-3072 profile, `--embed=defer`): +46 memos (5 v1-tasks chunks, 11 memory.surrealdb-era, 2 biographer-threads, 2 learning-queue, 1 communication-style facet, 1 domain-confidence, 1 session-handoff), +253 events (247 inbox + 4 log + 2 from the line-suffix de-dup change), +7 derived_from edges from new chunking, +1 source file (cali-trip). 0 errors. Final population: 553 memos · 669 events · 277 entities · 903 edges · 311 rules · 1 refusal.

Tests: 4 new parser tests for the inbox/log header shapes (`## YYYY-MM-DD HH:MM` and `## [YYYY-MM-DD] freeform title`) and 1 for many-same-day same-hash de-dup via line suffix; integration test fixture extended with all five new branches plus `memory.surrealdb-era/` + `artifacts/` + the inbox/log shapes, expected memo count moved from 5 to 12, expected event count from 3 to 6, and new assertions confirm `breakdown_events` is populated, persona's `comm_style.communication-style` is set, and `artifacts/` rows land in `_v1_imports`.

### MCP SSE round-trip + daemon supervisor lifecycle

Five independent defects collectively prevented the v2 daemon from being usable via the SSE transport from Claude Code / Gemini CLI:

- **MCP POST /messages routing.** The daemon implemented only the server→client half of the SSE protocol (`GET /sse` + `event: endpoint`). The client→server half (`POST /messages?sessionId=…`) had no handler, so every JSON-RPC request after the initial handshake 404'd. Added `handlePostMessage` (sessionId→transport map keyed by the SDK's transport ID) and routed it in `http.js` **before** `readJsonBody` — the SDK reads the raw body via `raw-body` and would parse-error if anything upstream drained the stream.
- **Daemon singleton vs. embedded-DB writer lock conflated.** Both used `.daemon.lock`. Every long-running CLI subcommand (biographer `process-pending`, `dream run`, `ingest`) held it, blocking `mcp restart` for as long as the LLM call took. Split into `.daemon.pid` (process singleton, daemon-only) and `.daemon.lock` (embedded-mode CLI serialisation, kept for the `--no-surreal` path). `mcp status`/`mcp stop` already read `.daemon.state`, so no client-side change needed.
- **`--foreground` was ignored.** The launchd plist and systemd unit both invoked `robin mcp start --foreground`, but `mcpStart` always detached and exited in ~50 ms — the supervisor was tracking the wrapper, not the daemon, so `KeepAlive=true` / `Restart=always` never actually restarted the daemon on crash. `mcpStart` now checks `argv` for `--foreground` and `await`s `startDaemon()` in-process; the detached path remains the default for interactive CLI use.
- **Ephemeral port on every restart.** The daemon called `listen(0)` and stamped a fresh port into `~/.claude.json` / `~/.gemini/settings.json` only at `mcp install` time — every subsequent restart broke the registered URL. New `cfg.mcp.port` field, reserved once at install; `bindPort(preferred)` tries it first and degrades to ephemeral on `EADDRINUSE`. Steady-state survives `mcp restart` and launchd-supervised crash recovery on the same port.
- **PID-reuse hazard in `acquireDaemonLock`.** Any live PID in the lock file was treated as "the daemon is up" — but a recycled PID landing on an unrelated biographer/dream subprocess would block the new daemon indefinitely. Added `isDaemonProcess(pid)` cmdline sniff via `ps -p <pid> -o command=` against two markers (`/system/runtime/daemon/server.js`, `\brobin\s+mcp\s+start\b`). Pluggable via `opts.isDaemonProcess` for tests; production callers leave it unset and get the real check.
- **`mcp install` racing the supervisor.** `launchctl unload` + immediate `launchctl load` collided with the old daemon's ~seconds-long graceful shutdown; the new daemon saw the still-alive old PID and exited `EALREADY`, only recovering after launchd's ~10 s `KeepAlive` throttle. `mcpInstall` now calls `mcpStop()` (SIGTERM + poll) before touching the supervisor.
- **Plist/unit mode regression.** `writeFileSync(path, content, { mode: 0o600 })` only honours `mode` on CREATE; re-installs over an existing file kept the prior permissions (commonly 0644 under default umask), silently undoing the 0600 hardening from the earlier b939c83. Added explicit `chmodSync` after the write in both `mcp-install.js` and `surreal-install.js`.
- **Test fix.** `multi-instance.test.js` predated the `/internal/*` bearer-token auth gate and didn't send the token, so its 10 parallel requests universally 401'd. Now reads `state.auth_token` and includes the `Authorization: Bearer` header — independent of the MCP work but blocked the full-suite green run.

Verified: 1447 unit + all integration tests pass; live launchd-supervised daemon survives a manual SIGTERM and respawns on the same persisted port within ~9 s; full MCP handshake (`initialize` + `notifications/initialized` + `tools/list`) returns 71 tools via the SSE↔POST split.

### Standalone SurrealDB server architecture + install/daemon hardening

The embedded `@surrealdb/node` engine is single-writer; concurrent Robin processes (daemon + biographer + CLI commands all firing from hooks) deadlock on the surrealkv lockfile. `robin install` now installs and supervises a standalone SurrealDB server (launchd plist on macOS, systemd user unit on Linux), writes `db.url: ws://127.0.0.1:8000` plus per-install credentials into `config.json`, and all consumers connect through it. Multi-writer arbitration is delegated to surreal where it belongs.

- **Auto-supervise.** New `system/runtime/install/surreal-plist.js` + `surreal-unit.js` generators; new `surreal-install.js` command (parallel shape to `mcp-install.js`) that writes the supervisor file, records it in `host-integrations.json`, loads it via `launchctl load` / `systemctl enable --now`, and polls `/health` until the server is ready (up to 30s). Idempotent in `upgrade()`, so `npm install` against an existing install picks it up.
- **Per-install random root password.** Surreal `--user root --pass <random>` with a 24-byte hex password generated at install time. Plist/unit files and `config.json` are chmod 0600 to keep the password out of other local users' reach.
- **client.js sign-in.** `connect({ engine, auth })` auto-signs-in when the engine is `ws/wss/http/https`; `defaultDbAuth()` reads `db.user`/`db.pass` from `config.json`. Embedded engines (`mem://`, `surrealkv://`, `rocksdb://`) skip auth.
- **`--no-surreal` escape hatch.** Falls back to embedded NAPI. Interactive mode requires `i-understand` confirmation because concurrent writers will deadlock.
- **Doctor.** `robin doctor` now probes the surreal `/health` endpoint when `db.url` is remote, reports auth_token presence, and no longer false-alarms on `engine: ws (config) ≠ surrealkv (on-disk)` (in ws mode the on-disk format is owned by the surreal binary, not by our connect path).

### Daemon `/internal/*` bearer-token auth

The daemon binds 127.0.0.1 only, but anything else running on the same machine (browser tabs, scripts, other user accounts) can hit it. Now a per-boot 64-char hex token gates `/internal/*` endpoints, written to `.daemon.state` (chmod 0600) so CLI + hook callers can read it but unrelated processes can't.

- **Daemon side.** `randomBytes(32).toString('hex')` at boot, passed to `startHttp({ authToken })`. `/internal/*` returns 401 `RobinUnauthorizedError` without `Authorization: Bearer <token>`. The non-`/internal/` surface (health probes, `/sse`) is unaffected — MCP transport has its own auth surface, and probes need to work for supervisors that don't carry the token.
- **Client side.** `daemon-request.js` reads `state.auth_token` and adds the header. All four direct-fetch callers updated: `commands/remember.js`, `cognition/intuition/handler.js`, `io/hooks/stop-hook.js`, `io/hooks/session-start.js`.
- **Backward compat.** State files written by old daemons omit `auth_token`; both sides treat missing token as no-auth so `robin mcp restart` cleanly upgrades both directions.

### MCP daemon supervisor + Ollama auto-start

- **launchd / systemd PATH fix.** Plist/unit now pin an absolute node binary (`process.execPath` at install time) and seed `PATH`. The shebang on `system/bin/robin` is `#!/usr/bin/env node`, which launchd's stripped PATH can't resolve — every restart attempt was failing silently and spawning thrash loops.
- **`mcpEnsureRunning` poll-while-alive.** Replaced the rigid 5s × 100ms poll with a poll-while-alive loop: keep waiting as long as the spawned PID is running, fail fast when the PID dies (with the last 20 lines of `daemon.log`), generous 60s upper bound. Surfaces the real cause when the daemon dies during startup (db lock contention, missing secret, etc.) instead of a generic "failed within 5s".
- **`mcpStart` returns the PID** so the poll can monitor it.
- **`validateOllama` auto-start + auto-pull.** When the `ollama` binary is on PATH but the daemon isn't running, install spawns `ollama serve` detached and polls; if `qwen3-embedding:8b` is missing, install runs `ollama pull` with inherited stdio (progress bars visible). All injectable via `whichFn`/`spawnFn`/`spawnSyncFn` for tests. Helpers extracted to `system/runtime/install/ollama-profile.js`.
- **Gemini embedder.** `embedBatch` transparently chunks at the 100-request `BatchEmbedContents` cap, and 429/5xx responses get exponential backoff (4s, 8s, 16s, 32s, 64s, 128s with jitter) so a large backfill drains across rate-limit windows instead of bailing out.

### npm postinstall + `--upgrade`

- `npm install` against an already-installed Robin now runs `robin install --upgrade` (idempotent refresh of migrations, hooks, manifest, supervisor, surreal-install) instead of printing a manual-step hint.
- `upgrade()` self-heals the `.robin-home` pointer when the legacy default home (`<packageRoot>/user-data/`) has a `.robin-data` marker but no pointer file — covers users from before pointer-based home tracking existed.
- `install --force` now merges over existing config.json instead of clobbering it; user-set fields (custom integrations, `hooks.disabled`, db overrides) survive a reinstall.

### CLI UX

- `robin --help` shows a one-line description for every leaf subcommand (~45 added across `mcp/*`, `jobs/*`, `rules/*`, `actions/*`, `auth/*`, `secrets/*`, `predictions/*`, `integrations/*`, `pre-commit/*`, `hooks/*`, `biographer/*`).
- `robin mcp bogus` now prints `unknown subcommand: bogus\nusage: robin mcp <start|stop|...>` with the parent breadcrumb, instead of a bare `<start|stop|...>`.
- Tool handler exceptions returned through MCP are sanitised to `tool '<name>' failed (<ErrorName>). See daemon.log for details.` — the raw `e.message` could carry paths, URLs, or API response bodies.
- Boot warns when running with embedded engine (loud signal for `--no-surreal` users) so a daemon-vs-hook deadlock is easy to diagnose.
- Fixed typo: `robin secret set` → `robin secrets set` in the gemini-3072 boot error.

### v1 → v2 markdown migrator (`robin import-v1`)

One-shot CLI that imports a v1 markdown user-data tree into the v2 SurrealDB. Markdown-only input (no v1 SurrealDB dependency); content-hash dedup via a new `_v1_imports` ledger (migration `0023-v1-imports.surql`) so re-runs are O(1) skips and rollback is session-scoped.

- **Hybrid mapping strategy.** Curated v1 content (`knowledge/`, `profile/`, `self-improvement/{rules,patterns,preferences}.md`, `ENTITIES.md`, `LINKS.md`, `watches/`, `memory/archive/`) lands directly as `entities` + `memos` + `edges` + `persona`. Time-series content (`streams/{journal,log,decisions,inbox}.md`, `self-improvement/corrections.md`) is replayed as `events` with `biographed_at=NULL` so the heartbeat picks them up on its normal cadence (no LLM cost at migration time). `memory/quarantine/` → `refusals` (audit-only). `sources/**` → `cp -a` into `<robin_home>/sources/`.
- **Schema delta.** `0023-v1-imports.surql` adds the ledger table with `UNIQUE(content_hash)` and `INDEX(import_session)`. Every migrated row also stamps `meta.imported_from='v1'` and `meta.v1_source_path` for in-row provenance.
- **Module layout.** `system/runtime/install/v1-import/` — `index.js` (orchestrator), `ledger.js`, `tx.js`, `chunk.js`, `taxonomy.js`, `report.js`, `parsers/{frontmatter,entities-md,links-md,dated-entries,list-of-entries}.js`, `writers/{entity,memo,edge,event,persona,rule,refusal}-writer.js`, `passes/{0-entities-md,a-entities,b-memos,c-links,d-events,e-rules-patterns,f-sources,g-embed}.js`. CLI entry `system/runtime/cli/commands/import-v1.js` registered as `import-v1`.
- **Transactional writes.** Every writer issues a single multi-statement `BEGIN/CREATE row/CREATE _v1_imports/COMMIT` query with a JS-side-generated record ID, so atomicity is preserved without round-tripping the auto-id. Aborted runs never leave a row without its ledger entry; re-runs resume via the unique content_hash index.
- **Edge kinds.** Imported edges stay within v2's `EDGE_KIND_REGISTRY`: `about` (memo → entity for each knowledge/profile-person memo), `mentions` (memo → entity, with `meta.contexts[]` accumulating across multiple LINKS.md rows for the same `(from, to)`), `derived_from` (child chunk → parent memo when long content is split), `supersedes` (new memo → old memo on re-import after a source edit).
- **Long-content chunking.** Files over 8 KB are paragraph-split into ≤6 KB chunks at `\n\n` boundaries. The parent memo carries the first chunk; children are linked via `derived_from`. Neither `embeddings-backfill.js` nor `embed/backfill.js` chunk, so this is required to keep the embedder from choking on oversized seeds.
- **Embedding.** `--embed=sync` (default) invokes `cognition/jobs/internal/embeddings-backfill.js` at the end of the import; `--embed=defer` skips it (heartbeat backfills in the background).
- **CLI.** `robin import-v1 --src <path> [--dry-run] [--embed=sync|defer] [--rollback] [--session <id>] [--include-views]`. `--src` accepts either `.../user-data` or `.../user-data/memory`. `--dry-run` parses + counts against an ephemeral `mem://` DB without touching the target. `--rollback [--session <id>]` deletes a session's target records (cascade-on-delete edge triggers wipe associated edges) plus the ledger rows themselves; `sources/**` filesystem copy is left in place. Refuses to run if the daemon is up.
- **Tests.** 37 parser/taxonomy unit tests, 10 writer unit tests against `mem://`, 3 end-to-end integration tests (fixture tree → expected counts, re-run idempotency, rollback). 50 total — all green.
- **Spec.** `docs/superpowers/specs/2026-05-11-v1-to-v2-data-migrator-design.md`.

### Cognition wave (B1 + A3 + C1 + D1 + B2 + D2 + D3 + C2 + C3)

Nine post-alpha.16 cognition features landed in two parallel waves:

**Wave 1 — recall foundation, biographer batching, focus block.**

- **B1: Per-hit reinforcement attribution.** `system/cognition/intuition/attribute.js` (new) wires the explicit → citation → similarity → fallback chain. `recall_log.ranked_hits[*].used` plus top-level `reply_event_id` + `attribution` (7-field object) added by migration `0009-per-hit-reinforcement.surql`. New outcome `evaluated_no_used`. Session-ID plumbing wired through handler → daemon → inject. Runtime config: `runtime:reinforcement.config.{mode, similarity_threshold, jaccard_min_overlap_tokens, fallback_when_no_reply}` — ships in `'off'` mode for safe rollout.
- **A3 + A1 + A2: Recall eval harness + real-cosine MMR + entity boost.** New `system/cognition/intuition/{eval,eval-labels,eval-metrics,vectors,entities}.js`. CLI: `robin recall-eval` (text + `--json`). Migration `0010-recall-eval-and-mmr.surql` adds `recall_eval_runs` table + `intuition_telemetry.meta` FLEXIBLE field. Entity-aware boost from `runtime:recall.value.entity_boost_enabled` (catalog match + prior-tail biographed entities). Fixed pre-existing `getRecallConfig` SurrealDB v3 parse bug.
- **C1: Biographer event batching.** `system/cognition/biographer/{batch-prompt,batch-output,accumulator}.js` (new). One LLM call per N events (defaults: `max_batch_size=8`, `debounce_ms=750`, `max_wait_ms=3000`). Per-episode-group mark UPDATE; per-event validation; failure isolation. Single-event `biographerProcess` preserved as wrapper. Rollback knob: `batch_config.disable=true`. Telemetry counters on `runtime:biographer.value` (input/output tokens, via_batch/via_fallback splits).
- **D1: State_inference activation.** New `system/cognition/memory/state_inference.js`, internal job `state-inference.js`, MCP tool `explain_state_inference`. `<!-- current focus -->` block prepended above `<!-- relevant memory -->` (200-token cap; 7 suppression rules: disabled/no_memo/low_confidence/stale/superseded/pivot/private). Three-stage rollout migrations `0012/0013/0014`. Source resolution via `ROBIN_SOURCE`/`CLAUDE_PROJECT_DIR`/`GEMINI_CLI_SESSION`. Writes `recall_log.meta.focus_block_present`/`focus_block_tokens` for A3 stratification.

**Wave 2 — quality + meta-cognition + parallelism + telemetry umbrella.**

- **B2: Contradiction surfacing at recall.** `system/cognition/intuition/conflicts.js` (new). `<!-- conflicts -->` block above `<!-- relevant memory -->` (cap 300 tok; total ceiling 2000 with all three blocks active). Wires `contradictionCount` into BOTH `score()` callsites (previously dormant). 5 suppression rules including outbound-blocked redaction. Migration `0015-conflict-surfacing.surql`.
- **D2: Recall-failures meta-cognition.** Weekly Sunday-05:00 LOCAL internal job `meta-recall-narrative.js`. Pure-JS clustering by `about`-edge endpoints, one `tier:'fast'` LLM call, emits `kind='reasoning'` memo + `rule_candidates` (`kind='behavior'`, `payload.source='meta_cognition'`). Shared `kindFilter()` in `store.js` so `searchMemos` accepts `kind: ['knowledge', 'reasoning']` (extended in `inject.js`). Migration `0018-meta-cognition.surql`. Reserved `meta.dimension='recall_failures'`.
- **D3: belief() gating + calibration meta-narrative.** New `system/cognition/belief/*` + MCP tool `belief({query, domain?, k?})` returning `assert | soften | unknown`. Weight = `signal_count × decay × relevance` (no confidence multiplier — avoids `fn::freshness` double-count). Direct + transitive privacy filter. Sunday 05:30 LOCAL meta-calibration writer (staggered after D2). `rule_candidates` with `payload.source='meta_cognition_calibration'`. Migration `0019-belief-gating.surql`. Reserved `meta.dimension='calibration'`.
- **C2: Dream DAG + persona refactor.** Layered concurrent scheduler in `system/cognition/dream/{dag,scheduler,step-registry,telemetry,dream-budget}.js`. Three layers L1 (`knowledge, patterns, reflection, profile, arcs, commStyle, confidence`) → L2 (`scopeCleanup, calibration`) → L3 (`compaction`). `updatePersonaFields` refactored from `UPSERT MERGE` to field-scoped `UPDATE SET` (fixes cross-process MERGE race). 80/20 dream/cadence budget split. Migration `0020-dream-dag.surql`. Flag-gated via `runtime:dream.config.parallelism_enabled`.
- **C3: Telemetry umbrella.** New `telemetry_hourly` table + per-faculty `rollup-registry.js`. Hourly aggregator (`telemetry-rollup.js`) + retention (`telemetry-prune.js`). Privacy/cardinality contract on dimensions (string|bool|int only, ≤64 chars, ASCII, ≤16 keys for object fan-out). New MCP tool `show_telemetry_rollup` (shadow_mode for first week). New indexes on `recall_log.evaluated_at`. Doctor probe for pending recall_log > 7d. Migration `0017-telemetry-umbrella.surql`.

### Cognition wave default-on flip (migration `0021-cognition-wave-enable.surql`)

Operator default. After this migration every cognition-wave feature is live:

| Feature | Runtime config | New default |
|---|---|---|
| B1 per-hit reinforcement | `runtime:`reinforcement.config`.value.attribution_mode` | `'hybrid'` |
| B2 contradiction surfacing | `runtime:recall.value.conflict_surfacing_enabled` | `true` |
| C2 dream DAG parallelism | `runtime:`dream.config`.value.parallelism_enabled` | `true` |
| C3 telemetry umbrella | `runtime:`telemetry.config`.value.shadow_mode` | `false` |
| D2 recall-failures meta-cognition | `runtime:`meta_cognition.config`.value.enabled` | `true` |
| D3 belief() gating | `runtime:`belief.config`.value.shadow_mode` | `false` |

Already-on (no flip needed): A1 cosine MMR, A2 entity boost, C1 biographer batching (default), D1 state_inference (flipped to `true` by 0014). Operators can revert any flag via a one-line `UPDATE runtime:`<key>` SET value.<field> = <old>;` — the 5-second config cache picks up the flip on the next call.

### Follow-up cleanups

**Batched CLI catchup.** `robin biographer-process-pending` and `robin biographer-catchup` now group pending events by source and call `biographerProcessBatch` in chunks of 8 (matching the daemon's accumulator default), with per-event fallback if the batch call fails. Closes C1's "CLIs still loop single-event" follow-up.

**C1 Gate #7 verification.** New integration test in `biographer-batch-pipeline.test.js` makes the host throw 3 times on the batch call, asserts retry budget is exhausted, fallback runs per-event, and `runtime:biographer.value.last_fallback_reason='network'` lands. Closes the deferred C1 Gate #7.

**C1 Gate #9 verification.** New integration test injects a transient `Transaction conflict` on the first mark-step UPDATE, asserts `withTxRetry` converges, and both events still get `biographed_at` set. Closes the deferred C1 Gate #9.

**C1 cross-batch `before` edges.** New per-source cursor `runtime:biographer.value.last_event_by_source` chains the last event of batch K to the first event of batch K+1 when they belong to the same episode. Closes the deferred C1 "cross-batch before edges" item.

**C2 DAG edge `step-compaction ← step-confidence-recompute`.** Compaction now waits for confidence-recompute to settle (avoids archiving memos whose freshness was about to cross threshold). Closes the documentary C2 §Open-items entry.

**arcs edge-registry support.** New `arc_contains` edge kind (arcs → episodes) is registry-validated and written by `extendArc` via `relateAll`. The legacy `meta.episode_ids` array remains as a defensive mirror. Closes the v1 deferral in `arcs.js`.

**D3 `ctx.catalog` plumbing collapse.** `belief.js` fallback now delegates to `cognition/intuition/entities.js:readEntityCatalog` (A2's cached 60-second TTL reader) so the belief tool and the recall path share a single entity-catalog source of truth. Closes D3 §Open-items.

**B1 session_id fallback.** `tools.js` adds `getMostRecentSessionId()` that falls back to `runtime_sessions WHERE status='active' ORDER BY last_seen_at DESC` when no in-process `ctx.sessions.active` is set. MCP recall tools called from Claude Code now naturally pick up the live session for `recall_log` correlation. Closes B1 §Open-items.

**Structured telemetry tables** (migration `0022-structured-telemetry.surql`). Two new SCHEMAFULL tables provide structured per-run history for downstream tooling, additive to the existing runtime-counter / `cadence_telemetry` rows:

- `biographer_telemetry` — one row per batch with `source`, `via ∈ {'batch', 'fallback'}`, `batch_size`, `input_tokens`, `output_tokens`, `duration_ms`, `fallback_reason`. Closes C1 §Open-items "Telemetry table".
- `dream_telemetry` — one row per step per dream run with `step`, `layer ∈ {1, 2, 3}`, `duration_ms`, `tokens_in`/`tokens_out`, `success`/`error`, `parallel` flag (distinguishes the scheduler path from the serial fallback). Closes C2 §Open-items "Separate dream_telemetry table".

**Lint warnings cleared.** Two pre-existing optional-chain warnings in `system/cognition/belief/calibration.js` resolved; lint reports 0 warnings.

### Test coverage delta

- Unit tests: 1060 → **1369** (+309)
- Integration tests: 124 → **259** passing (+135; 1 pre-existing skip)
- Lint: **clean** (Biome, 755 files, 0 warnings)
- All 9 features ship with operator-controlled flags. Migration 0021 flips them to live defaults; tests that exercise the off/shadow path now set their precondition inline so they remain meaningful post-flip.



- New `system/runtime/install/postinstall.js` registered as `package.json#scripts.postinstall`. After `npm install` the script runs `robin install --auto`, wiring up the home directory, embedder profile, migrations, hooks, daemon supervisor, and MCP host registration with no further user input.
- New `--auto` flag on `robin install`: equivalent to `--yes --profile mxbai-1024 --on-existing ignore`. Explicit flags still win, so `robin install --auto --profile gemini-3072 --i-understand` keeps the gemini profile.
- Gating: postinstall skips silently in CI, on transitive installs, when `ROBIN_SKIP_INSTALL` is set, and when prior install state (`.robin-home` pointer or `user-data/.robin-data` marker) is already present. Global installs and Windows print a hint and exit 0. Setup failures never block `npm install`.
- Per-step skip envs map 1:1 to install flags: `ROBIN_SKIP_MCP`, `ROBIN_SKIP_DAEMON`, `ROBIN_SKIP_HOOKS`, `ROBIN_SKIP_AGENTS_MD`, `ROBIN_SKIP_SUPERVISE`, `ROBIN_SKIP_REGISTER`.
- Tests: 2 new install.test cases for `--auto` defaulting and explicit-flag-precedence, plus a new `postinstall-gating.test.js` covering 5 skip conditions.
- Docs: README quickstart and `docs/install.md` rewritten around the new one-step flow with a "When the postinstall skips itself" table.

## [6.0.0-alpha.17] — 2026-05-11 — Package restructure to `system/`

Reorganizes the package tree from a flat 20-folder `src/` layout into a
five-layer `system/` tree. **Code-only restructure — no data migrations, no
schema changes, no public API changes, no behavior changes.**

### What moved

- `src/` → `system/` with five layers:
  - `runtime/` — process lifecycle (cli, daemon, install, hosts, scripts)
  - `data/` — persistence (db with migrations inside, embedders)
  - `cognition/` — named faculties (intuition, biographer, discretion, dream)
    + substrate (memory, jobs)
  - `io/` — boundaries (capture, outbound, hooks dispatcher, integrations, mcp)
  - `config/` — cross-cutting configuration (flat)
- `bin/`, `scripts/`, `tests/` all moved under `system/`
- Faculties absorb their primary engines: `recall/` → `cognition/intuition/`,
  `graph/` → mostly `cognition/biographer/` (episodes → memory), `capture/biographer-*.js`
  → `cognition/biographer/`, hook handlers → respective faculty folders,
  `outbound/policy.js` → `cognition/discretion/outbound-policy.js`
- Folded folders: `rules/` (candidates → dream, rules → memory), `secrets/`
  (→ config), `schema/migrations/` (→ data/db/migrations/)
- Heartbeat and introspection live in `runtime/daemon/` because functionally
  they're scheduling / self-check, not memory operations
- Renames: `daemon/scheduler.js` → `daemon/heartbeat.js`,
  `hooks/cli.js` → `hooks/dispatcher.js`, `capture/biographer.js` →
  `biographer/pipeline.js`, `daemon/biographer-queue.js` → `biographer/queue.js`

### Why

20 flat folders in `src/` had become hard to navigate. Distribution was uneven
(1 file in `secrets/`, 96 in `integrations/`). Named faculties from
`docs/faculties.md` were scattered. The new tree groups by responsibility and
surfaces faculties as first-class folders. See
`docs/superpowers/specs/2026-05-11-robin-v2-package-structure-design.md` for
placement rules, import-direction rules, and the migration mapping.

### Package surface

- `package.json` "bin": `system/bin/robin`
- `package.json` "files" lists `system/` and shipped docs
- `.npmignore` excludes `system/tests/` and `system/runtime/scripts/`
- Test/script paths in npm scripts updated

### Breaking? No.

External consumers see no API change — the `robin` CLI command is unchanged,
all MCP tool names are unchanged. Only contributors editing internals will
notice the path changes.

## [6.0.0-alpha.16] — 2026-05-11 — Robin v2 evolution (7 themes)

Lands the seven-theme umbrella spec from `docs/superpowers/specs/2026-05-11-robin-v2-evolution-roadmap.md`. Each theme adds a layer of cognitive lifecycle above the schema substrate.

### Theme 1c — Scope rework + private-block bug fix

- **The headline bug fix.** Outbound discretion now refuses to forward
  payloads referencing private-scoped memos/events/entities (direct + via
  `<-derived_from<-memos[WHERE scope='private']`). Closes the redesign-spec
  promise that was previously unenforced. `refusals` rows logged with
  `reason='private_scope'`.
- `src/memory/scope-registry.js` is the new single source of truth for scope
  policy: `policyFor`, `validateScope`, `scopeMatches`, `persistentScopesSqlFilter`,
  `ephemeralEntries`. Replaces hardcoded SQL prefix lists in `store.js`
  (`_surfaceSearch` filter) and `step-scope-cleanup.js`.
- Hierarchical scopes via `/` path notation: `project:robin` matches
  `project:robin/v2/theme-1c` but not `project:robin-other`. New
  `scope_descends_from` option on `store.searchMemos/Events/Entities` and
  on the recall MCP tool.
- Writes validate scope against the registry (unknown patterns rejected).

### Theme 2a — Evidence ledger + derived confidence

- New `evidence_ledger` table (append-only) + `fn::derived_confidence`
  SurrealQL function. Confidence becomes derivable from accumulated
  corroborations / refutations via pseudocount-prior Beta-ish blend:
  `(initial × prior_weight + Σcor)/(prior_weight + Σcor + Σref)`.
- Producers:
  - `reinforcement.js` writes `corroborates` on reinforce **and `refutes`
    on correction** (the missing symmetric path).
  - `store.relate(..., 'contradicts')` auto-emits two refute rows.
  - Biographer optional `evidence_signals[]` output — `addEvidence` invoked
    per signal at `biographer_weight` (default 0.5).
- New `step-confidence-recompute` dream step: lazy refresh of stored
  `memos.confidence` for memos with recent ledger activity.
- New MCP tools: `endorse`, `refute` (manual evidence at `manual_weight=2.0`).
- Schema: `0003-evidence-ledger.surql` + `runtime:evidence.config`.

### Theme 2b — Action-trust ledger + decay + DENY escalation

- New `action_trust_ledger` table; every state change emits a row.
- **Time-based decay sweep** (heartbeat every 6h): `AUTO` classes unused
  for `decay_days` (default 90) → demoted to `ASK`.
- **Consecutive-correction escalation**: N corrections in a row (default 3)
  with no `success` between → state → `DENY` automatically.
- `update_action_policy` MCP gains optional `reason` (propagates to ledger).
- Schema: `0004-action-trust-ledger.surql` + `runtime:action_trust.config`.
  `0001-init.surql` action_trust enums widened (DENY state; correction_loop
  + decay_sweep set_by) — requires destructive DB reset.

### Theme 3 — Cognition cadence (trigger queue + budget)

- New `dream_triggers` queue (append-only) + `cadence_telemetry` (per-run
  cost) + per-step processing cursors.
- Heartbeat consumer (every 60s) drains the queue: enforces debounce,
  hourly cap, daily cap, and **daily token budget**. Live budget decrement
  inside the loop ensures the consumer halts within one tick of exhausting.
- Trigger-eligible steps: `reflection`, `comm-style`, `calibration` (others
  remain nightly-only).
- Producers: `reinforcement.js` (correction landed → reflection trigger),
  `foresight.resolve` (prediction resolved → calibration trigger).
- Budget derivation: 7-day rolling median of daily `cadence_telemetry`
  token sum, with safety margin (default 20%).
- Schema: `0005-cadence.surql` + `runtime:cadence.config` + `.cursors`.

### Theme 1a — Compaction + archive tier

- New `step-compaction` dream step (after `step-scope-cleanup`).
- **Dedup** via existing `supersedes` machinery: groups `kind='knowledge'`
  memos by `content_hash`, picks canonical (highest signal_count × confidence,
  earliest tiebreak), emits supersedes to rest. `fn::freshness` already
  returns 0 for superseded → they vanish from recall but stay queryable.
- **Archive tier**: per-kind eligibility (age + signal_max + meta.resolved_at)
  moves stale memos to `archive_memos` + incident edges to `archive_edges`
  + audit row to `archive_log`. `archiveMemo` / `restoreMemo` round-trip
  preserves content + scope + tags + edges.
- Recall structurally cannot reach archive tables (no FTS / vector index).
- Schema: `0006-compaction.surql` + `runtime:compaction.config`.

### Theme 1b — Episodes + arcs (multi-episode containers)

- New `arcs` table — first-class multi-episode containers with status
  (active / paused / closed), `last_activity_at`, FTS on name + summary.
- `src/memory/arcs.js`: `createArc`, `getArc`, `listArcs`, `extendArc`
  (Jaccard-based dedup), `jaccard` helper.
- `src/dream/step-arcs.js`: nightly clustering of recent episodes by
  shared participating entities (≥ `min_shared_entities` overlap →
  cluster; cluster size ≥ `min_episodes` → arc). Dedup against existing
  active/paused arcs by Jaccard ≥ `dedup_jaccard_threshold` (default 0.7).
  Auto-state-transition: idle > `pause_after_idle_days` → paused;
  idle > `close_after_idle_days` → closed.
- `closeStaleEpisodes` heartbeat sweep (every 10 min): episodes whose
  `last_event_at` exceeds per-source idle threshold → `ended_at` set.
- Episode schema additions: `last_event_at`, `summary_log` (bounded
  array of recent event previews).
- New MCP tools: `list_arcs`, `get_arc`.
- Schema: `0007-arcs.surql` + `runtime:arc.config` + `runtime:episode.config`.

### Theme 4 — Observability + introspection

- Seven new MCP introspection tools (read-only, audit-gated):
  - `explain_recall` — recall_log rows with ranked_hits + score components
    + sources (private-scope hits stripped before return).
  - `explain_belief` — memo + `evidence_ledger` replay +
    `supersedes`/`contradicts` edges + `fn::derived_confidence` value
    + the derivation formula (private-scope content redacted).
  - `explain_action_trust` — current state + full `action_trust_ledger`
    history.
  - `show_pending_triggers` — unprocessed `dream_triggers`.
  - `show_step_health` — per-step `cadence_telemetry` rollup over a window.
  - `recent_refusals` — filterable refusals listing.
  - `archive_history` — `archive_log` filtered by memo_id.
- New `robin doctor --health` CLI mode with status rollups (token budget,
  pending triggers, dream freshness, faculty error rate). Exit codes 0/1/2
  enable cron-based monitoring. `--json` flag for machine-readable output.
- Schema: `0008-doctor.surql` (config row only — read layer is code).

### Cross-cutting

- New `audit-introspection-readonly.test.js`: introspection tool files must
  not contain `CREATE`/`UPDATE`/`DELETE`/`UPSERT`/`INSERT`/`RELATE`.
- `audit-no-old-tables.test.js` extended with a `kind: 'thread'` tripwire
  (deprecated in favor of arcs table).
- Three new heartbeat phases wired into the daemon: cadence consumer (60s),
  close-stale-episodes (10 min), action-trust-decay (6h). All `.unref?.()`'d
  so they don't keep the process alive on shutdown.
- `0001-init.surql` checksum changed (action_trust enum widening). Existing
  instances need a destructive DB reset — same playbook as the prior
  redesigns.

## [6.0.0-alpha.15] — 2026-05-11 — SurrealDB improvements (4 phases)

Corrects the prior redesign's TYPE NORMAL premise and lands four orthogonal
improvements. See `docs/superpowers/specs/2026-05-11-surrealdb-improvements-design.md`
for the full spec.

### Schema

- **Edges: `TYPE NORMAL` → `TYPE RELATION`** (no FROM/TO clause, preserves
  open-enum kinds). Composite array IDs `edges:[kind, in, out]` keep idempotent
  counter semantics via `INSERT RELATION ... ON DUPLICATE KEY UPDATE`. Arrow
  traversal (`<-edges[WHERE kind=X]<-source`, recursive `{1..N}`, `+shortest`,
  `+collect`) now works across the codebase. The HANDOFF.md assertion
  "TYPE NORMAL is incompatible with graph arrows; composite-ID UPSERT requires
  TYPE NORMAL" was wrong — both can coexist on `TYPE RELATION` tables.
- **Field rename `from`/`to` → `in`/`out`** across schema + ~20 src files +
  ~14 test files. Public JS signatures (`store.relate(db, from, to, kind)`,
  `validateEdge(from, to, kind)`) preserve `from`/`to` parameter names for
  caller readability; mapped to `in`/`out` internally.
- **FULLTEXT BM25 indexes** on `events.content`, `memos.content`,
  `entities.name` with a shared `english` snowball analyzer.
- **`REFERENCE ON DELETE UNSET`** on `events.episode_id` with COMPUTED
  `episodes.member_events` back-ref.
- **`REFERENCE ON DELETE IGNORE`** on `rule_candidates.signal_events` and
  `rules.source_candidate` (preserves audit history when source rows are
  deleted).
- **COMPUTED `runtime_jobs.is_overdue`** — pure same-row predicate for the
  heartbeat dispatcher.
- **`events_meta_kind` field-path index** for the reinforcement correction
  scan.
- **`runtime:recall` config row** seeded with RRF k, kNN over-fetch
  multipliers, MMR threshold.

### Engine

- New default: `surrealkv://` (the v3 successor to rocksdb). Configurable via
  `<robinHome>/config.json.db.engine`. `surrealkv+versioned` (time-travel
  reads) currently hangs in @surrealdb/node 3.0.3 — flipping is a one-line
  config change once that's resolved upstream.
- All 30+ CLI/daemon/script call sites route through `defaultDbUrl()` in
  `src/db/client.js`.

### Hot-path batching

- `store.relateAll`: N sequential UPSERTs → one multi-statement
  `INSERT RELATION ... ON DUPLICATE KEY UPDATE` wrapped in BEGIN/COMMIT,
  chunked at 50. ~10-20× latency drop on biographer per-event commit.
- `store.getMemo`: 4 sequential SELECTs → one multi-statement query with LET
  blocks (single round-trip).
- `reinforcement.evaluatePending`: ~1200 queries / 200 pending rows → ~7
  queries via pre-fetched correction window, bucket-by-count memo updates
  (preserves the "memo recalled in N pending rows → signal_count += N"
  semantics), and one UPDATE per outcome bucket on `recall_log`.

### Hybrid retrieval (BM25 + vector + RRF)

- New `src/recall/fusion.js`: `rrfFuse` (`1 / (k + rank)`) + `padDistances`
  (BM25-only hits get neutral cosine=0.5).
- `_surfaceSearch`: runs HNSW kNN and BM25 in parallel, fuses via RRF.
  Adaptive over-fetch on the kNN side scales with active filter count,
  mitigating post-filter shrinkage. BM25 fails-soft if FULLTEXT indexes are
  unavailable.
- Tunables in `runtime:recall` (5s-cached): `rrf_k`, `knn_overfetch_base`,
  `knn_overfetch_per_filter`, `mmr_threshold`.
- `hits[].record._sources` (`['knn', 'bm25']`) surfaces retrieval-lane
  contribution per hit; written to `recall_log`, stripped from agent-facing
  MCP payloads.

### Verification

`scripts/verify-design-assumptions.js` extended from 4 gates to 9:
- G5 arrow traversal on TYPE RELATION + mid-edge kind filter.
- G15 REFERENCE back-ref `<~events` equals `WHERE episode_id = $X`.
- G16 ON DELETE UNSET clears scalar pointer.
- G17 COMPUTED `is_overdue` across the (next_run_at × in_flight × enabled) matrix.
- G18 `entities_name_lower` index still selected by the planner.

All gates green. Unit suite 976/976 + integration 112/112 (1 skipped, 0 fail).

### Migration

Destructive reset required — `0001-init.surql` checksum changed; the
migration runner throws on mismatch. No data migrator (per spec; v2 had no
users / no data).

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.robin-assistant.mcp.plist
cp -R <robinHome>/db <robinHome>/db.pre-alpha15  # safety
rm -rf <robinHome>/db/*
# update config.json db.engine if migrating from rocksdb
# restart daemon
```

## [6.0.0-alpha.14] — 2026-05-11 — Post-redesign cleanup

Audit pass on top of `alpha.13`. No new features.

### Removed (dead code that targeted the pre-redesign schema)

- `src/migrate-v1/` — broken v1→v2 migrator targeting the old v2 schema. The eventual v1→v2 migrator will be written from a fresh spec.
- `src/db/browse/` — DB browser UI hard-coded to old `knowledge` / `patterns` / `threads` / `recall_events` tables; the rewrite is deferred.
- `src/cli/commands/embedder-switch.js` + the `robin embedder switch` CLI — superseded by `robin embeddings prepare|backfill|activate|drop`.
- `src/cli/commands/migrate-from-v1.js`, `src/cli/commands/db-browse.js` — wrappers for the removed modules.
- `src/mcp/tools/mark-recall-used.js` — the reinforcement loop (`src/recall/reinforcement.js`) makes manual marking unnecessary.
- `src/memory/scopes.js` — spec'd but no consumer wired up.
- 20+ `tests/unit/migrate-v1-*.test.js`, `tests/unit/db-browse-utils.test.js`, and integration tests for the removed modules.
- `tests/integration/migration-0009.test.js`, `tests/integration/cascade-end-to-end.test.js` — both target deleted migrations / modules.
- Misc unused exports: `embed/types.js#PROFILES`, `dream/prompts.js#PATTERN_CONFIRM_SYSTEM`, `chrome/client.js#{dateToChromeTime,urlToHost}`, `lunch_money/client.js#getMe`, `nhl/client.js#fetchClubStats`.

### Fixed (production bugs surfaced by the redesign)

- `src/mcp/tools/recall.js` — rewrote against the canonical `recall_log` schema (`query`, `k`, `ranked_hits`); the old shape (`hit_ids`, `hit_used`, `query_text`) was rejected on every invocation.
- `src/jobs/ingest-resolver.js` — `resolveOrCreateEntity` was writing `embedding` inline on `entities`; now delegates to `store.upsertEntity`, which routes through the per-profile embedding surface.
- `src/dream/step-reflection.js` — was selecting `events.embedding`; now joins back from `embeddings_<profile>_events`.
- `src/embed/backfill.js` + the daemon's backfill-due check — same fix: anti-join against the per-profile embedding table instead of the removed `embedding` column.
- `src/daemon/introspection.js#readLastIntrospection` — tolerate `runtime_introspection_state` not yet existing on a fresh DB.
- `src/capture/record-event.js` + `src/memory/store.js#remember` — normalize a top-level `external_id` argument into `meta.external_id` so integration writers don't drop the field.
- `src/jobs/predictions.js#coerceMemoId` — switched from string-id interpolation to a `RecordId` binding; the string form returned no row under some seed orderings.

### Toolchain

- `@biomejs/biome` `1.9.4 → 2.4.15` (ran `biome migrate`; auto-fixed 288 files; added `.claude/` to `files.ignore`).
- `better-sqlite3` `11.10.0 → 12.9.0`.

### Verification (this branch)

| Check | Status |
|---|---|
| `npm run lint` | 0 errors, 0 warnings, 567 files |
| Unit suite (`tests/unit/**`) | 969 / 969 pass |
| `scripts/verify-design-assumptions.js` | 4/4 gates pass |
| `scripts/test-store-smoke.mjs` | pass |
| `scripts/test-reinforcement-smoke.mjs` | pass |
| `scripts/test-intuition-loop-smoke.mjs` | pass |
| `scripts/test-scope-cleanup-smoke.mjs` | pass |
| `scripts/verify-hnsw-plan.mjs` | pass |

Integration suite has a handful of remaining fixtures still on the pre-redesign shape (events.embedding column reads, ENFORCED schema rejects) — not blocking; they fail loudly when run.

## [6.0.0-alpha.13] — 2026-05-11 — DB + memory layer redesign (last big schema reshape)

Destructive reset of the schema and memory layer. Spec at `docs/superpowers/specs/2026-05-11-robin-v2-database-and-memory-redesign-design.md`; plan at `docs/superpowers/plans/2026-05-11-robin-v2-database-and-memory-redesign.md`; handoff at `HANDOFF.md`.

### Schema

- **One init migration replaces 14.** `0001-init.surql` defines events / memos / entities / episodes / edges / persona / runtime tables + `fn::freshness` + cascade events. Per-profile embedding tables in `0002-embeddings-<profile>.surql` (3 surfaces per active profile; profile swap is non-destructive).
- **3 substrate tables, 1 edges table.** `memos` is kind-discriminated; the open kind enum + `MEMO_KIND_REGISTRY` mean adding a new kind is a code change, never a migration. Edges use composite IDs `edges:[kind, from, to]` with registry-validated endpoints + symmetric canonicalization + counter (`SET weight += 1`) semantics for `occurs_with`.
- **Open enums throughout.** `memos.kind`, `entities.type`, `events.source`, `events.trust`, `edges.kind` unconstrained; in-code registries enforce shape.
- **Embeddings separable from data.** `embeddings_<profile>_{events,memos,entities}` tables; data tables carry no embedding columns.

### Memory layer (`src/memory/`)

- **`store.js`**: only writer to memos / edges / embeddings.
- **Faculty renames**: `hot.js` → `attention.js`; `journal.js` → `chronicle.js`; `patterns.js` → `habits.js`; `profile.js` → `persona.js` (table renamed too); `threads.js` → `narrative.js`. `knowledge.js` kept name. `foresight.js` is new — consolidates predictions.
- **`kind-registry.js`** + **`edge-registry.js`** + **`scopes.js`** + **`decay.js`** + **`embed/profile-router.js`**: in-code validation, scope constants, JS freshness mirror, active-profile resolution.

### Recall pipeline (`src/recall/`)

- **`rank.js`**: composite score = `cosine × freshness × contradiction-penalty × trust-factor × scope-boost` + MMR-lite.
- **`reinforcement.js`** + **`jobs/internal/reinforce-recall.js`** (every 5 min): the keystone effectiveness fix — useful memos sharpen with use, noisy memos that lead to corrections don't.
- **`recall/index.js`** rewritten as adapter over `store.searchEvents`; legacy `{ hits: [...] }` shape preserved.
- **`recall/intuition.js`** writes `intuition_telemetry` + `recall_log{outcome:pending}` rows.

### Dream

- `step-patterns` queries `edges WHERE kind='occurs_with'`; emits via `habits.upsert`.
- `step-threads` queries `edges WHERE kind='mentions'`; emits via `narrative.add`.
- New `step-scope-cleanup` promotes referenced ephemerals to global; prunes stale ephemerals (session: 7d, temp: 24h).

### Naming sweep

| Old | New |
|---|---|
| Edge `co_occurs_with` | `occurs_with` |
| Edge `precedes` | `before` |
| Memo kind `pattern` | `habit` |
| Table `profile` | `persona` |
| Table `runtime_intuition_telemetry` | `intuition_telemetry` |
| Table `recall_events` | `recall_log` |
| Module `hot.js` | `attention.js` |
| Module `journal.js` | `chronicle.js` |
| Module `patterns.js` | `habits.js` |
| Module `profile.js` | `persona.js` |
| Module `threads.js` | `narrative.js` |

### Verification

`scripts/verify-design-assumptions.js` covers 4 gates against SurrealDB 3.0.5. `scripts/test-store-smoke.mjs`, `scripts/test-reinforcement-smoke.mjs`, `scripts/test-intuition-loop-smoke.mjs`, `scripts/test-scope-cleanup-smoke.mjs`, and `scripts/verify-hnsw-plan.mjs` cover end-to-end primitives + the reinforcement loop + scope cleanup + HNSW operator selection. `tests/unit/audit-no-old-tables.test.js` asserts production source contains zero references to the old table/edge names. Lint clean. Unit suite 955/990 (96.5%); 35 remaining failures are stale test fixtures (deferred follow-up).

### What's NOT in this release

- v1→v2 migrator rewrite (out of scope; `src/migrate-v1/` left stale).
- Reasoning-trace / code-edit / session-outcome event writers (schema-ready; writers deferred).
- Reranker training (uses `recall_log` reinforcement outcomes; arrives later).
- Full test-suite update (~35 unit tests remain on stale fixtures; deferred).

## [6.0.0-alpha.12] — 2026-05-11

Post-alpha.11 follow-on bundle: user-data isolation cutover, faculty renames, DB browser ship, long-form docs, non-interactive install, log rotation, and restored per-phase hooks-disable. 14 commits + ~984 unit tests passing.

### User-data isolation

- **`src/runtime/data-store.js`** is now the sole path resolver. Strict `robinHome()` with no silent fallback; `paths.data.*` (under `<robinHome>/`) and `paths.source.*` (under package root). `.robin-data` marker + `.robin-home` pointer in package root + `expectedHome` baked into the supervisor unit.
- **Interactive picker** in `robin install` — four options (package_root/user-data, `~/.robin`, `~/Documents/Robin`, custom). Discovery scans known locations on reinstall; existing-data migration prompt uses copy-verify-delete (never `fs.rename`). New flags: `--home`, `--relocate`, `--repair`.
- **`robin install` non-interactive flags** (spec §9.5) for unattended runs: `--yes` (default home, no prompts), `--existing <path>` (declare known prior install, bypass discovery scan), `--on-existing=move|copy|ignore|abort` (answer to migration prompt; defaults to `abort`), and `--force` (allow targeting an empty directory without the Robin marker). Adds `planInstallHome()`, a side-effect-free resolver for tests + scripted installs. 10 new tests in `install-noninteractive.test.js`.
- **`installed-hooks.json` and `hooks-disabled.txt` retired**, folded into the unified `host-integrations.json` manifest and `config.json.hooks.disabled` respectively. Both files migrate on first write.
- **`bin/robin-hook.sh`** is pure passthrough; no resolver in shell.
- **launchd plist + systemd unit** bake `ROBIN_HOME=<home>` and the daemon log path; both are recorded in the manifest with `expectedHome`.
- **`robin uninstall`** is manifest-driven, best-effort by default. `--strict` aborts on first failure, `--purge` removes the home dir. OS-aware daemon stop via `launchctl bootout` / `systemctl stop` from the manifest.
- **`robin doctor`** gains a Data section reporting home resolution, env/pointer mismatch, manifest health, and drift on host-integration entries.
- **Audit tests** — `tests/unit/audit-no-tilde-robin.test.js` and `audit-user-data-construction.test.js` enforce no source references `~/.robin` or constructs `user-data` paths outside the allow-list.

### Faculty renames (in-flight from alpha.11)

- `bash-policy` → `discretion`, `auto-recall` → `intuition`, `tamper-check` → `introspection`. Surfaces every long-lived mechanism under a named faculty. AGENTS.md, hooks, daemon endpoints, and tests all renamed in lockstep.

### Per-phase hooks-disable (restored)

- Reverses the alpha.11 regression that collapsed per-phase disable into a single global boolean. Storage shape: `config.json.hooks.disabled` is now a `string[]` of disabled phase names. `disabled === true` (legacy) is read as "all phases disabled"; `disabled === false` / missing reads as "none". Disabling one phase no longer suppresses the others. The `hooks-disabled.txt` → `string[]` migration in `ensureHome()` parses newline-separated phase names with `#` line comments. 15 new tests across `hooks-disabled.test.js` and `hooks-disabled-migration.test.js`.

### DB browser

- **`robin db browse`** — opens an in-daemon SurrealQL workbench at `http://127.0.0.1:<daemon-port>/db/`. Sidebar of saved queries, schema explorer, dashboards (inventory, trends, analysis cards), and a live SurrealQL editor. Loopback-only with Host/Origin checks. Daemon mounts the route lazily on boot; the CLI just opens the URL. Shipped alongside its 1,800 lines of server + static frontend, plus 20 unit + integration tests.

### Job runner additions

- **`log-rotate` internal job** — every 6 h, copy-then-truncates `daemon.log` when it exceeds 10 MB (override via `config.json.logs.rotateAtBytes`). Keeps one archive (`daemon.log.1`). Copy-then-truncate (rather than rename-and-recreate) preserves the daemon's open fd held by launchd's `StandardOutPath`.

### Documentation

- **Five long-form docs** committed under `docs/`: `architecture.md` (big-picture + agent-turn walkthrough), `faculties.md` (per-faculty deep dive), `install.md` (full walkthrough + picker + secrets + OAuth + Discord + pre-commit), `development.md` (adding tools, integrations, hooks, migrations), `troubleshooting.md` (common problems and fixes). Referenced from the README documentation table.

### Cross-phase

- **`ROBIN_POINTER_PATH` test-only env override** in `data-store.js` — lets integration tests that exercise `writePointer` use a per-test tmpdir instead of stashing/restoring the real `<packageRoot>/.robin-home`. Production never sets the env var.
- **Lint debt cleanup** — biome unsafe fixes (template literals, single-var declarators) applied to six 4b.3 files; biome.json ignores `user-data/`.
- **Pre-existing `ERR_MODULE_NOT_FOUND` failures cleared** — the 10 module-not-found errors from alpha.11 referenced renamed files (`bash-policy.js`, `tamper-check.js`, `step-corrections.js`, `intuition` handlers) and resolved as the rename pass landed. Full unit suite is now 979/0.

### What did NOT ship in this bundle

- **Phase 4e (trained reranker + knowledge-promotion classifier)** — still blocked on accumulated `recall_events` and labeled data.
- **Phase 4c leftovers (Save Conversation + Deep-ripple)** — still deferred pending a fresh brainstorm now that 4f session capture is shipped and the biographer queue is settled.

## [6.0.0-alpha.11] — 2026-05-11

Phase-4 progress bundle: 4d (job runner) + 4c (knowledge ops) + 4b.1 (action policy) + 4b.2 (comm-style) + 4b.3 (predictions + calibration). Five sub-phases shipped together; combined +130 tests; full suite at 1067/0.

### Phase 4d — Daemon-internal job runner

- **Migration `0011-jobs.surql`** — `runtime_jobs` table tracks per-job state (schedule, enabled, runtime, catch_up, notify, in_flight, success/failure counts, last/next-run timestamps, manually_runnable). UNIQUE index on `name`.
- **Markdown-defined jobs** at `<robinHome>/jobs/*.md` + built-ins at `src/jobs/builtin/*.md`. Loader globs both directories on every heartbeat tick; user copy wins by name. No copy-on-boot step — avoids re-copy-of-deleted-builtin and stale-after-`npm update` pitfalls.
- **In-tree cron parser** (`src/jobs/cron.js`) — 5-field + `@`-aliases (`@daily`, `@hourly`, `@weekly`, `@monthly`, `@yearly`). Brute-force forward minute-scan capped at 5,000,000 iterations (≈10 years) to support yearly without false unreachability. TZ via `process.env.TZ`.
- **Heartbeat integration** — Dream pipeline's existing 60s tick gains a 3rd surface alongside integrations and dream. Dispatch order: integrations → dream → jobs. Catch-up matrix: `last_run_at IS NONE + catch_up:true` → fire next tick; `last_run_at IS NONE + catch_up:false` → schedule to nextFire; `behind by 1.5× cadence + catch_up:true` → single catch-up fire.
- **Two runtimes** — `agent` (LLM-driven, body is the prompt, `host.invokeLLM` with `tier:'deep'`, 15min timeout) and `internal` (dynamic-import `src/jobs/internal/<name>.js`).
- **Notify dispatch** — `discord_dm` / `capture` / `both` / `none`. Empty allowlist throws `'no discord notify target'`. Over-2000-char content truncated to 1996+`…` (vs agent-driven discord_send which refuses). Failure path uses `source: 'job_notification'`.
- **CLI**: `robin jobs <list|status|run|enable|disable|reload>`. **MCP tools**: `list_jobs`, `run_job` with `manually_runnable: false` gate so destructive maintenance jobs (future: db-backup, prune) can't be agent-fired.
- **`/internal/jobs/run`** and **`/internal/jobs/reload`** daemon endpoints. Both call `planNextRunAt` after a job fires so the manual-trigger path stays consistent with the scheduler path.
- **Built-in `daily-briefing.md`** ships disabled — opt-in via `robin jobs enable daily-briefing` once Discord + integrations are configured.
- **AGENTS.md** `<!-- robin-jobs:start -->` block lists known jobs (enabled + disabled).

### Phase 4c — Knowledge ops (Ingest + Lint + Audit)

Three agent-callable MCP tools for memory hygiene. User-triggered only (AGENTS.md enforces by prose); skipped Save Conversation + Deep-ripple (4f overlap, defer).

- **`ingest({content?, url?, file_path?})`** — write a source document into events + entities + edges + knowledge in one shot. 1 MB cap on all input types. URL: `Content-Type` check (`text/*` or `application/json`); binary refused. file_path: any absolute path the daemon can read. Content-hash dedup returns `{ok:true, deduped:true, event_id}` BEFORE recordEvent (no phantom rows). Inbound PII guard. LLM-driven extraction (NEW prompt, NOT biographer's — biographer is conversation-shaped). New `resolveOrCreateEntity` helper (name + alias-as-name matching against `entities_name_lower` composite index; aliases preserved in `entity.meta`). Edge RELATE source branches by kind (events→entities vs entities→entities per migration 0003 FROM types). Writes through `createKnowledge` from `src/memory/knowledge.js`.
- **`lint({limit})`** — read-only mechanical sweep. Five checks, severity-sorted: `dead_edge` (5), `orphan_entity` (4 — counts inbound edges across all 6 edge tables), `duplicate_entity` (3 — same `name_lower + type`), `near_duplicate_knowledge` (2 — pairwise JS cosine since SurrealDB v3 doesn't allow combining HNSW with `vector::similarity::cosine()` in the same query), `stale_knowledge` (1 — `confidence < 0.3 AND updated_at < now - 30d`). Symmetric pairs deduped via canonical `[low, high]` ordering. `runLintChecks(db, {cutoffDate?})` for testability.
- **`audit({pair_count})`** — read-only LLM contradiction-pair scan. Recent (30d) candidates → pure-JS cosine NN → cosine > 0.7 → canonical pair ordering. ~8 LLM calls per invocation (`tier:'balanced'`). Malformed JSON output treated as `{contradict:false}` — single bad pair doesn't fail the audit.
- **CLI**: `robin ingest <content|--url|--file>`, `robin lint [--limit N]`, `robin audit [--pairs N]`.
- **Daemon endpoints**: `/internal/knowledge/{ingest,lint,audit}`.
- **AGENTS.md** `<!-- robin-knowledge-ops:start -->` block. "User-triggered, never autonomous" rule.

### Phase 4b.1 — Action policy + action-trust ledger

Per-(tool, action_template) AUTO/ASK/NEVER state. Defaults to ASK; auto-demotes AUTO→ASK when the agent calls `record_correction({tool, action, ...})`.

- **Migration `0012-action-trust.surql`** — `action_trust` table keyed by `class` (e.g. `discord_send:send_dm`). Tracks `state`, `set_by` (user/correction/default), `success_count`, `correction_count`, `last_used_at`, `last_state_change_at`. UNIQUE index on `class`.
- **Helpers** (`src/jobs/action-trust.js`) — `checkActionTrust(db, tool, action)` (auto-creates with state='ASK' on first sight), `setActionTrust`, `recordOutcome` (auto-demotes AUTO→ASK on correction), `demoteOnCorrection`, `getActionTrust`, `listActionTrust`, `resetActionTrust`.
- **MCP tools** — `check_action({tool, action})` (read-only peek), `update_action_policy({class, state})` (agent-facing flip when user gives standing permission).
- **Three outbound tools wrapped** — `discord_send`, `github_write`, `spotify_write` all gain a pre-check at handler entry. AUTO proceeds, ASK refuses with `{ok:false, reason:'requires_permission', class, last_state_change_at}` unless `args.force === true`. NEVER refuses regardless of force. On success, `recordOutcome(db, cls, 'success')`. Pre-existing unit tests pre-seed AUTO in their setup helpers.
- **`record_correction` demote wiring** — optional `tool` + `action` args trigger auto-demotion of the matching class. Returns `demoted_class` field.
- **CLI**: `robin actions <list|show|set|reset>`. Set/reset go through daemon endpoints (`/internal/actions/{set,reset}`) so the DB stays single-writer.
- **AGENTS.md** `<!-- robin-actions:start -->` block describes the AUTO/ASK/NEVER protocol + `force: true` escape hatch.
- **Deferred to 4b.1b**: Dream-driven auto-promotion proposals, 7-day probation, 90-day decay.

### Phase 4b.2 — Comm-style profile inference

Nightly LLM synthesis of the user's communication-style preferences from correction events.

- **Migration `0013-comm-style.surql`** — extends `profile` with `comm_style` (FLEXIBLE option<object>). Seeds `profile:singleton` so `setCommStyle` UPSERTs have a deterministic target.
- **Inferred fields** — `tone` (terse/balanced/verbose), `formality` (casual/balanced/formal), `emoji_ok`, `direct_feedback_ok`, `code_comment_density` (minimal/moderate/verbose), `summary_style` (bullets/prose/mixed), plus `evidence` (event IDs), `confidence` (0..1), `last_synthesized_at`.
- **Threshold guard** — <3 signals → persist defaults with `confidence: 0` without invoking the LLM. Avoids noisy synthesis on sparse data.
- **Synthesis** — `synthesizeCommStyle(db, host)`. Queries `events WHERE meta.kind = 'correction' AND ts > now - 30d` (production source value is `'manual'` with `meta.kind: 'correction'`, not `source: 'correction'` — discovered at implementation time). LLM call (`tier:'balanced'`) with numbered corrections. Malformed JSON or invalid shape preserves prior `comm_style` (don't overwrite valid with bad).
- **Dream step-comm-style** runs nightly as a 6th step in the pipeline. Fail-soft.
- **MCP tool `get_comm_style()`** returns populated defaults with `synthesized: false` when null (agent doesn't need to handle null).
- **CLI**: `robin commstyle <show|refresh>`.
- **AGENTS.md** `<!-- robin-comm-style:start -->` block surfaces inferred preferences at session start. Static fallback when not yet synthesized.

### Phase 4b.3 — Predictions + calibration

Per-(prediction kind) accuracy tracking, fed back to the agent so it knows how much to trust its own future claims.

- **Migration `0014-predictions.surql`** — `predictions` table with `statement`, `kind`, `confidence`, `predicted_at` (READONLY default), `expected_resolution_at?`, `resolved_at?`, `correct?`, `actual_outcome?`. Also adds `calibration` field to `profile`.
- **Three MCP tools** — `predict({statement, kind, confidence, expected_resolution_at?})`, `resolve_prediction({id, correct, actual_outcome?})`, `list_open_predictions({kind?, older_than_days?})`. `kind` is free-form (`duration`, `fact_recall`, `preference_guess`, `event_timing`, etc.) — agent picks the taxonomy.
- **`computeCalibration(db)`** — per-kind accuracy + total_open/total_resolved counts. Resolved-only predictions enter `by_kind`; open ones contribute to `total_open` only.
- **Dream step-calibration** runs nightly as a 7th step (pure math, no LLM). Stores in `profile.calibration`.
- **CLI**: `robin predictions <list|resolve>`, `robin calibration`.
- **`/internal/predictions/resolve`** and **`/internal/calibration/refresh`** daemon endpoints.
- **AGENTS.md** `<!-- robin-calibration:start -->` block. Static fallback ("no calibration data yet") when empty. Populated form surfaces per-kind accuracy + open count + the instruction to call `predict()` on falsifiable claims.

### Cross-phase

- **Polish batch (commit `0f8103e`)** — bootstrap-empty-db now uses `/applied \d+ migrations/` regex (no more brittleness on each new migration); added missing `dead_edge` + `near_duplicate_knowledge` lint coverage; added `behind-by-1.5×-cadence` catch-up tests for the scheduler.
- **Single-pass DB read** for AGENTS.md generation (`readDbDataForAgentsMd` in `mcp-install.js`) fetches jobs + commStyle + calibration in one rocksdb open/close cycle, avoiding the v3.0.3 close-hang on sequential reads.
- **Coordination pattern** for parallel subagent dispatch — Wave 1 sequential (so dependent waves see the initial commit), subsequent waves parallel where files don't overlap.
- **Test count**: 1067/0 with all 14 migrations applying cleanly. Pre-existing 4f `biographer-process-pending-captures.test.js` still hangs (~88s); the documented workaround excludes it from autonomous suite runs (`find tests -name '*.test.js' | grep -v biographer-process-pending-captures`).

Phase 4 envelope status: 4a + 4b.1 + 4b.2 + 4b.3 + 4c + 4d + 4f all shipped. Remaining: 4e.1 (trained reranker — needs `recall_events` accumulation), 4e.2 (knowledge-promotion classifier — needs labeled data), 4c leftovers (Save Conversation, Deep-ripple — overlap with 4f, revisit once 4f stable).

## [6.0.0-alpha.10] — 2026-05-10

Phase 4f: conversation capture. Replaces v1's `migrate-auto-memory` job with a host-agnostic Stop-hook capture step. Closes the last accidental gap from the v1→v2 audit (`migrate-auto-memory` is now formally **replaced**, not deferred or dropped).

- **New `src/capture/transcript.js`** — tail-and-parse the host transcript JSONL. Returns `{userText, assistantText, hasToolCalls, tsAssistant}`. Walks backwards past `tool_result` user-role messages to find the human prompt (Claude Code stores tool returns as user-role messages; Gemini CLI uses `function_response` — both handled). Tolerates malformed final lines (transcript-write race on Stop fire) by try-parsing every line and silently skipping JSON.parse failures.
- **New `src/capture/session-capture.js`** — `captureFromTranscript(db, embedder, {transcriptPath, sessionId, host})`. Skip heuristics in order: `no_transcript_path` → `no_assistant_turn` → `single_word_ack` (ok/yes/thanks/...) → `pure_tool_turn` (hasToolCalls && combined<30 chars) → `empty_turn` (<8 chars) → `dedup_hit` (content_hash already in `events` with `source='conversation'`) → `pii_refused`. PII guard wired (`guardInboundContent`); credential-shaped content refuses and logs to `outbound_refusals(direction='inbound')`. Skip-log JSONL line per fire to `<robinHome>/cache/logs/biographer.log` for threshold tuning.
- **New shared `src/runtime/file-tail.js`** — extracts `readFileTail(path, maxBytes)` previously private to auto-recall. Refactor only, no behavior change for 4a.
- **`'conversation'` added to `recordEvent`'s VALID_SOURCES.** Host (`claude_code`/`gemini`) goes into `meta.host`; `session_id` and `has_tool_calls` in `meta`. Single source value keeps recall queries simple (`WHERE source = 'conversation'` covers both hosts).
- **Stop hook extended** to forward `transcript_path` + `session_id` from the host stdin payload to the biographer subprocess — both via the daemon `/internal/biographer/process-pending` POST body and via the direct-spawn fallback's CLI flags (`--transcript-path`, `--session-id`). Injectable `fetchFn` / `readState` for tests.
- **`robin biographer process-pending`** accepts `--transcript-path <p>` and `--session-id <id>`. When `--transcript-path` is present, runs `captureFromTranscript` first (fail-soft) — embedder + host are hoisted so the biographer loop reuses them.
- **Daemon endpoint** `/internal/biographer/process-pending` accepts `{transcript_path, session_id}` in its POST body and runs the same pre-step before enqueueing pending events.
- **No new tables, no migration, no new endpoints.** Reuses `events`, the existing biographer queue, and the existing 4a `runtime_sessions.transcript_path` field. The biographer takes over from the captured event using its existing prompt — zero new LLM calls in the capture step itself; cost is one additional fast-tier biographer call per non-skipped turn.
- **Test count**: ~20 new tests across `transcript-parse` (7), `session-capture` (9), `stop-hook-forwards-transcript` (2), `record-event-conversation-source` (1), `file-tail` (3). Integration roundtrip via `biographer-process-pending-captures.test.js`.

Closes v1→v2 audit gap: `migrate-auto-memory` is now formally **replaced** by 4f's host-agnostic Stop-hook capture. Phase 4b (comm-style profile) is now unblocked — it has a steady source of conversation events to infer from.

## [6.0.0-alpha.9] — 2026-05-10

Phase 4a: daily-use safety floor. Restores the v1 safety + auto-recall guarantees on top of v2's MCP-first architecture, in a form that survives the npm-global install model.

- **Migration `0010-safety-floor.surql`** — adds `runtime_sessions` (multi-session registry with `transcript_path` for hook-side prior-turn lookup), `runtime_tamper_state` (singleton id `current`, with `findings.* TYPE object FLEXIBLE` for v3 SCHEMAFULL strictness), `runtime_auto_recall_telemetry` (append-only per-fire telemetry), and a `direction` column on `outbound_refusals` distinguishing inbound (PII guard refused a memory write) from outbound (existing behavior, default).
- **Bash policy** (`src/hooks/bash-patterns.js` + `src/hooks/handlers/bash-policy.js`) — 7 deny rules. Lifted v1's 6 (`secrets-read`, `env-dump`, `destructive-rm`, `low-level-fs`, `git-expose-userdata`, `eval-injection`); dropped `misrouted-write` (no canonical user-data/artifacts path in v2); added `db-direct-access` to refuse `surreal sql/connect/import/export` against the local `<robinHome>/db/`. PreToolUse Bash hook; static match (no daemon round-trip). Shape-tolerant accessor for stdin (`tool_input.command` → `command` → `input.command`).
- **PII guard inside MCP handlers** (`src/hooks/pii-patterns.js` + `src/hooks/inbound-guard.js`) — narrower than outbound: `INBOUND_DENY_PATTERNS` covers the 5 `SECRET_PATTERNS` plus `private_key_pem`, `jwt`, `password_assignment`. Medical/financial history can still enter memory (only outbound list blocks those leaving). Wraps `recordEvent` via injectable `input.guard`; `remember`, `record_correction` MCP tools wired in. `RobinPiiRefusedError` thrown on refusal; daemon's tool-error wrapper surfaces the message to the agent. Override only via CLI: `robin remember --force`. Refusals visible via `robin refusals list`.
- **Tamper detection** — daemon-boot manifest check. `src/install/manifest.js` computes `<robinHome>/manifest.json` (package version + sha256 of `bin/robin`, `bin/robin-hook.sh`, key handler files; mode of `secrets/.env` + `db/`; supervisor checksum). `src/daemon/tamper-check.js` runs full check at daemon boot, persists `runtime_tamper_state` (singleton id `current`). SessionStart hook reads the cached state — never recomputes. `robin doctor --rebaseline` re-baselines after legitimate changes.
- **Auto-recall on UserPromptSubmit** (`src/recall/auto-recall.js` + `src/hooks/handlers/auto-recall.js`) — recall-only shim. Hook reads `transcript_path` from its stdin payload, tails the last 8 KB of JSONL, extracts the most recent assistant message (string or `{type:'text',text}` block array, 2000-char cap), POSTs `{query, prior_assistant, k:6, recency_days:30, token_budget:1500}` to daemon's `/internal/auto-recall` with `AbortSignal.timeout(300)`. Daemon endpoint reuses the existing `recall()` pipeline, formats hits as `<!-- relevant memory -->` block, greedy-packs under token budget (1 token ≈ 4 chars), writes `runtime_auto_recall_telemetry` row. Fail-soft on every error path. **Cutover suppression** (spec §8): if `$CLAUDE_PROJECT_DIR/system/scripts/hooks/host-hook.js` exists, v2 hook yields with one stderr line — no double `<!-- relevant memory -->` blocks during v1 + v2 overlap.
- **Multi-session registry** (`src/daemon/sessions.js`) — `registerSession`, `endSession`, `markStaleSessions`, `listActiveSessions`, `purgeStaleSessions`. `runtime_sessions` UPSERT on unique `session_id`. Daemon stale-sweeper `setInterval(60_000)` marks sessions `last_seen_at > 5min` as `stale`. `robin sessions [--stale]` CLI lists/purges. `/internal/session/{register,end}` endpoints in daemon HTTP server.
- **Pre-commit privacy hook** (`src/install/pre-commit.js` + 3 CLI commands) — standalone, NOT bundled into `robin install`. `robin pre-commit install` (in user's repo cwd) writes `.git/hooks/pre-commit` only if missing — never overwrites unrelated user hooks. `runPreCommit` scans `git diff --cached` for `.env`/`secrets/` paths and `SECRET_PATTERNS` shapes; refuses commit on hit. Idempotent install via path-marker; uninstall removes only if our hook is present.
- **Hook installation/uninstall** (`src/install/hook-shim.js` + `src/install/hooks-settings.js`) — `bin/robin-hook.sh` POSIX shim resolves node from `$ROBIN_NODE` → `command -v node` → `$NVM_DIR` → `$ASDF_DIR` → common paths; fail-soft (exit 0 with stderr trace) so a broken shim never breaks the host. `installHooksToSettings` deep-merges robin entries into `~/.claude/settings.json` and `~/.gemini/settings.json` `hooks.{PreToolUse,UserPromptSubmit,SessionStart,Stop}` — Gemini gets only Bash + Stop + SessionStart (spec §10). Identity = exact command-string match. Foreign entries preserved byte-for-byte. Manifest at `<robinHome>/installed-hooks.json`. `validateRobinResolvable()` blocks install if neither `command -v robin` nor the shim is reachable.
- **`robin install` extended:** new step 7 (tamper baseline write) + step 8 (hook install). Flags: `--no-hooks`, `--hooks-only` (repair after manual settings.json edits). `robin uninstall` removes hook entries and the `installed-hooks.json` manifest before unwiring MCP.
- **`robin doctor`** — minimal tooling per spec §13.5. `--rebaseline` rewrites the tamper manifest. `--purge-stale-sessions` cleans the registry. `--lint-hooks` lists robin-owned entries in user settings. No-flag prints a status overview.
- **Hook kill-switch** — `<robinHome>/hooks-disabled.txt` (newline-separated phase names, `#` comments allowed). `robin hooks disable <phase>` / `robin hooks enable <phase>` round-trip via atomic write. Hook dispatcher checks the file before any handler import — kill-switch works even when daemon is down.
- **6 new top-level CLI subcommands:** `robin hook <phase>`, `robin sessions [--stale]`, `robin refusals list`, `robin doctor [--flags]`, `robin pre-commit <install|uninstall|run>`, `robin hooks <disable|enable> <phase>`.
- **Test count:** 775/782 passing on full suite (7 pre-existing better-sqlite3 native-binding failures unrelated to 4a — chrome-sync, lrc-sync). 4a-specific tests: ~110 unit + 1 integration roundtrip across `bash-patterns`, `bash-policy-handler`, `pii-patterns-inbound`, `inbound-guard`, `record-event-pii`, `refusals-list`, `sessions`, `session-start-handler`, `manifest`, `tamper-check`, `auto-recall-endpoint`, `auto-recall-handler`, `hooks-settings`, `hook-shim`, `pre-commit`, `doctor`, `hooks-toggle`, `hooks-cli`, `hooks-disabled`, `hooks-install-roundtrip`.
- **What 4a does not do** — no agent-facing changes to MCP tool surface (PII refusals throw; existing tools' behaviors preserved). No changes to existing event/episode/entity/recall flows. Action policy (AUTO/ASK/NEVER), comm-style profile, predictions+calibration, learning-loop reranker — all deferred to 4b/4e per the Phase 4 envelope in `docs/superpowers/specs/2026-05-10-robin-v2-phase-4a-safety-floor-design.md` §1.

Phase 4b candidates: AUTO/ASK/NEVER action policy + action-trust ledger, predictions/calibration with outcome-check, comm-style profile inference. Phase 4c: knowledge ops (Ingest, Lint, Audit, Save conversation, Deep-ripple). Phase 4d: cross-platform job runner. Phase 4e: trained reranker + knowledge-promotion classifier (the learning loop).

## [6.0.0-alpha.8b] — 2026-05-10

Phase 3b: v1→v2 migrator + missing read-sync integrations + cleanup. Builds on Phase 3a (`v6.0.0-alpha.8a`) embedder profiles.

- **`robin migrate-from-v1`** — top-level CLI: idempotent (`sha256('v1:'+v1_id)` dedup via `events_from_v1_hash`/`entities_from_v1_hash`/`episodes_from_v1_hash` indexes), resumable (per-phase progress in `runtime:migration_progress`), audit-friendly (`meta.from_v1` provenance on every migrated row). Phase order: entity → episode → capture → edges → lossy. v1 `mentions` migrates lossy-as-events (the naive amplification would emit ~42K false-positive `events→entities` edges); biographer can re-derive proper edges as it processes captures.
- **5 phases × ~2,400 v1 captures + 950 entities + 38 episodes + ~3,800 lossy rows** map cleanly to v2 schema. v1 `transaction` and `watch` lossy-preserved (manual edits would have been overwritten by Lunch Money's API resync otherwise).
- **Audit/rework surface (§12 of spec)** — `--status`, `--show-failures [--phase X]`, `--reset [--phase X] [--dry-run]` with cascade rules, `--export-mappings <path>`, `--phase X` for selective re-run. Native data is never touched: every destructive op filters on `meta.from_v1.source_hash IS NOT NONE`. Cascade for `--reset --phase entity`: edges → lossy v1-edge events → entities. `docs/AUDIT.md` walkthrough + `scripts/audit-fixup.js.example` template.
- **`embed_backfill` daemon job** — singleton-cron drains rows where `embedding IS NONE AND meta.embed_failed IS NOT true`, batches of 64, every tick. Wired into `src/daemon/server.js` scheduler alongside `__dream__`. Embedder lazily loaded via 3a's `createEmbedder()` (mxbai/qwen3/gemini profile). Poison rows get `meta.embed_failed = true` and are excluded from future ticks.
- **`github` read-sync** — issues / PRs / notifications / releases-of-starred via `GITHUB_PAT`. Reuses `github_write/client.js` REST helpers. 1h cadence. 2 MCP tools: `github_recent_activity`, `github_notifications`.
- **`spotify` read-sync** — recently-played + top tracks/artists via existing `SPOTIFY_*` PROVIDERS entry. **Month-bucketed top-items external_ids** (`spotify:top_track:<window>:<YYYY-MM>:<id>`) preserve monthly snapshots instead of forever-deduping the first occurrence. Gap detection (>50 plays since last sync). 4h cadence. 2 MCP tools.
- **`letterboxd` CSV ingest** — drop `letterboxd-*.csv` into `<package_root>/user-data/upload/`. Diary-format detection by header columns; non-Diary CSVs moved aside with `.error.txt`. Processed files → `upload/processed/`. **No daemon restart needed** when dropping a CSV after install — preflight only ensures the upload dir exists; CSV check is a soft no-op inside `sync()`.
- **30-day backup auto-prune** — `src/db/backup.js` deletes archives older than 30 days before writing new tar. Override via `ROBIN_BACKUP_RETENTION_DAYS=N` (set to 0 to disable).
- **No encryption at rest** — explicit `## Security posture` section in AGENTS.md (regenerable via `<!-- robin-security:start/end -->`). RocksDB has no built-in encryption; rely on FileVault / LUKS at the filesystem layer. Threat model: single-user local install, device itself is trusted.
- **`0009-migrator-v1.surql`** — adds `meta.from_v1.source_hash` indexes on events/entities/episodes; `participates_in.meta` (FLEXIBLE) so v1 fields v2 doesn't define (confidence, valid_from, etc.) survive in `meta.v1_payload`; `events.embedded_at` field + `meta.embed_failed` for backfill tracking.
- **5 new MCP tools** (github×2, spotify×2, letterboxd×1) → integrations now total 19 (`gmail, google_calendar, google_drive, youtube, ga, lunch_money, weather, ebird, nhl, linear, whoop, chrome, lrc, discord, github_write, spotify_write, github, spotify, letterboxd`).
- **Cutover runbook** — see `docs/superpowers/specs/2026-05-10-robin-v2-phase-3b-migrator-design.md` §10. v6.0.0 publish stays gated on Phase 4 daily-use parity, not 3b.
- **Several SurrealDB v3 type-coercion gotchas** discovered during integration testing and documented in code comments: JS `null` ≠ SurrealDB `NONE` for `option<T>` fields (omit the field instead); `ts: time::now()` requires a `Date` object via `surql` template, not an ISO string; `episode_id: record<episodes>` requires reconstructing the RecordId from the resolver's string id; `ORDER BY <field>` requires `<field>` to appear in `SELECT`.
- **Test count**: 580/590 passing on full suite (10 pre-existing better-sqlite3 native-binding failures unrelated to 3b). All 3b-specific unit + integration tests pass.

Phase 3b candidates that didn't ship: forward-looking biographer hint replay from `v1_mentions` lossy events; reranker training-set bootstrapping from `v1_preference` + `v1_correction` (Phase 4 work).

## [6.0.0-alpha.8a] — 2026-05-10

Phase 3a: pluggable embedder profiles + ROBIN_HOME path refactor.

- **ROBIN_HOME path refactor.** Robin's data root moved from `~/.robin/` to `<package_root>/user-data/` (matching v1's pattern). `ROBIN_HOME` env var still overrides. `src/runtime/home.js` walks up from `import.meta.url` to find the package root; `paths()` returns `{ home, db, secrets, cache, config, backup, daemonState, daemonLock, migrationsDir }`.
- **Pluggable `Embedder` interface** at `src/embed/types.js` with three implementations chosen at install time:
  - `mxbai-1024` — in-process via `@huggingface/transformers` (`mixedbread-ai/mxbai-embed-large-v1`, 1024-dim, MTEB retrieval ~60). Default. (`Xenova/...` mirror is 401-walled — switched to upstream + `cls` pooling per model card.)
  - `qwen3-4096` — local via Ollama (`qwen3-embedding:8b`, 4096-dim, MTEB retrieval ~68). `OLLAMA_HOST` env var override; falls back to `/api/embeddings` on 404.
  - `gemini-3072` — Google AI Studio API (`gemini-embedding-001`, 3072-dim, MTEB retrieval ~68). Privacy disclosure + `--i-understand` required for non-interactive install: free tier trains on input.
- **Factory pattern.** `src/embed/factory.js` `createEmbedder()` reads profile from `<robinHome>/config.json` and dynamic-imports the matching impl. Daemon now wires `createIdleEmbedder({ factory: createEmbedder, idleMs: 600_000 })`.
- **Three migration files** at `src/schema/migrations/0008-embedder-<profile>.surql` — each redefines `embedding` field + HNSW index on `events`, `knowledge`, `entities` and `query_vec` on `recall_events` at the profile's dimension. Migration runner reads config and applies only the active profile's 0008.
- **`runtime:embedder` row** written by every 0008 migration. Daemon-boot drift detection refuses to start if `config.json.embedder_profile` ≠ `runtime:embedder.value.profile`, with a one-line remediation pointing at `robin embedder switch`.
- **Boot health-check** per profile via `idleEmbedder.get().healthCheck()` — Ollama unreachable / model missing / Gemini key absent each surfaces a profile-specific install-instruction line and `process.exit(1)`.
- **`robin install` rewrite** (`src/cli/commands/install.js`): multi-step idempotent flow with profile prompt, legacy `~/.robin/` detection, per-profile validation (Ollama probe, Gemini key + disclosure), `runMigrations`, daemon supervision wire-up via existing `mcpInstall`. Flags: `--profile <id>`, `--force`, `--i-understand`, `--no-mcp`, `--no-migrate` (test escape hatches). Injectable deps for testability.
- **`robin embedder switch <profile>` CLI** (`src/cli/commands/embedder-switch.js`): pre-clears stale-dim vectors (`events.embedding = NONE`, truncate `knowledge`/`entities`/`recall_events` since they regenerate from raw events via Dream + biographer + the recall feedback loop), drops the old `_migrations` row, re-applies 0008 at the new dim, re-embeds events resumably (progress in `runtime:embedder.value.switch_progress`).
- **Test stub default dim** bumped to 1024 (matching mxbai). 46 test files updated; obsolete bge-small tests (`embedder-real`, `recall-quality`) removed.
- **Test count:** 617/617 passing on full suite. Lint clean for all 3a-touched files.

Phase 3b (separate spec) handled the v1→v2 migrator + 3 missing read-sync integrations + 30-day backup auto-prune + no-encryption decision.

## [6.0.0-alpha.7] — 2026-05-10

Phase 2f: OAuth generalization + spotify-write + headless OAuth + rate limiter + 8 read-sync integrations.

- **OAuth2 generalization**: `_auth/oauth2-google.js` → `_auth/oauth2.js` with PROVIDERS registry (google/spotify/whoop). `google-token-cache.js` → `token-cache.js` keyed per-provider. Refresh-token rotation handled when provider declares `rotatesRefreshToken: true`.
- **Headless OAuth `--code` flag**: `robin auth google --code [<VALUE>]` for VM/SSH cases. Re-introduces `auth google/spotify/whoop` CLIs (removed in 2e). `--code=<VALUE>` inline; `--code` alone interactive prompt.
- **Per-tool rate limiter**: `runtime:outbound_rate.<tool>` sliding 1-hour window. Default 10/hr. Per-tool env override (`GITHUB_WRITE_RATE_LIMIT`, `SPOTIFY_WRITE_RATE_LIMIT`).
- **spotify-write**: tool-only with 3 actions (queue, skip, playlist-add). First integration to exercise refresh-token rotation roundtrip.
- **8 new read-sync integrations**: weather (6h), ebird (12h), nhl (12h), linear (1h), whoop (30m, 4-9am EDT only via quiet_window), ga (1d, requires `analytics.readonly` re-auth), chrome (1d, local SQLite), lrc (1w, local SQLite).
- **Manifest preflight**: optional `manifest.preflight()` async export. Failed preflight → `unavailable` list; daemon stays up; `integrations list` shows the row.
- **Quiet-window scheduler**: manifests can declare `quiet_window: { tz, active_hours }`. After each sync, `runIntegrationSync` advances `next_run_at` past inactive hours.
- **better-sqlite3** added as dep (transient client lib for chrome/lrc local SQLite reads; never used as storage — SurrealDB remains sole datastore).
- **13 new MCP tools** (44 baseline daemon surface; some preflight-gated by env / file presence).
- **AGENTS.md** updated with 16 integrations + spotify_write outbound caveat. Outbound writes section now covers both github_write and spotify_write with rate-limit semantics.
- **v1 env var compatibility verified at Task 0**: linear uses `LINEAR_API_KEY` (not `PAT`), ga uses `GA_PROPERTIES` (multi-property comma-sep), whoop adds `read:body_measurement` and `offline` scopes.
- **Apple Photos NOT included** (dropped per user directive during brainstorm).

Phase 2g candidates: `integration_run` MCP tool (deferred since Phase 2d), per-integration filtering in `integrations list`, `discord_send` MCP tool, additional v1 integrations as needed.

## [6.0.0-alpha.6] — 2026-05-09

Phase 2e: .env secrets layer + Calendar/Drive/YouTube + github_write.

- **Secrets layer rework:** Phase 2d's per-integration JSON files at `~/.robin/secrets/<name>.json` replaced with a single `${ROBIN_HOME}/secrets/.env`. Lazy `requireSecret(key)` reads, atomic write-temp-then-rename for `saveSecret` and `importFrom`. No `process.env` pollution. Each manifest declares `secrets.env_keys: [...]`.
- **`robin secrets import --from <path>`** copies v1's `user-data/runtime/secrets/.env` into v2's location with 0600 perms. **Required upgrade step from 2d.** Plus `robin secrets list` (key names only, never values) and `robin secrets set <KEY>` (interactive, no echo).
- **3 new sync integrations** all reusing `GOOGLE_OAUTH_*` env keys via a `google-token-cache.js` singleton (refresh-promise dedup):
  - `google_calendar` (30m, ±14d window, upsert)
  - `google_drive` (4h, 30d/200-cap first sync, upsert)
  - `youtube` (24h, three-kind capture: sub/playlist/liked, insert-or-skip)
- **`github_write` tool-only integration** — third manifest kind alongside sync and gateway. 4 actions (create-issue, comment, label, mark-read). Text actions through outbound-policy; non-text skip. create-issue and comment captures audit events to the events table; label and mark-read are daemon-log only.
- **7 new MCP tools** (31 total daemon surface): `calendar_list_events`, `calendar_get_event`, `drive_search`, `drive_get_file`, `youtube_list_subscriptions`, `youtube_list_liked`, `github_write`. `integration_run` gains `tool_only_no_sync` refusal reason.
- **Removed:** `auth gmail/lunch_money/discord` CLIs and `_auth/secrets-io.js`. OAuth loopback helper retained for 2f's headless flow.
- **AGENTS.md** restructured into three regenerable sub-blocks: Integration data freshness, Outbound writes (github_write), Available integrations.
- **Daemon boot warning** if `${ROBIN_HOME}/secrets/.env` is missing.
- **`integrations list`** now merges manifest registry with runtime row, displaying gateway/tool-only kinds correctly alongside synced integrations.

Phase 2f candidates: spotify-write, headless OAuth `--code` flag, rate limiter, remaining v1 integrations (weather, ebird, chrome, whoop, lrc, linear, nhl, photos, ga).

## [6.0.0-alpha.5] — 2026-05-09

Phase 2d: integrations framework + Gmail + Lunch Money + Discord bot.

- New schema (migration 0006 + 0007): `events.external_id` UNIQUE on `(source, external_id)`, `events.trust` marker, embedding relaxed to `option<>`, `outbound_refusals` table; 0007 relaxes the `events.source` ASSERT to allow integration sources and makes `content_hash` optional.
- **Integration framework** under `src/integrations/<name>/` — manifest + sync + tool factories + auth helpers. Heartbeat scheduler now drives per-integration cursors with per-name in-flight tracking. Backoff: 3 consecutive scheduled failures double the cadence (capped at 24h); manual triggers don't feed backoff. Daemon-boot in_flight cleanup clears stale flags from a crashed run. Dream cursor seeded + advanced as a special "__dream__" entry inside the same scheduler loop.
- **Three reference integrations:** gmail (15m, OAuth PKCE), lunch_money (1d, API key, upsert mode for edits), discord (in-process gateway bot, allowlist-gated, replies through outbound-policy).
- **5 new MCP tools** (24 total daemon surface): `gmail_search`, `gmail_get_thread`, `lunch_money_query`, `integration_status`, `integration_run`. `integration_run` enforces 30s min-interval + gateway/in-flight refusals.
- **9 new CLI commands:** `robin auth gmail/lunch_money/discord`, `robin integrations list/status/run`, `robin integrations discord register-commands`.
- **Outbound policy** (`src/outbound/policy.js`): PII / secret / verbatim-untrusted-quote (last 7d) guards. Discord bot replies pass through it; future github/spotify writes will too.
- **AGENTS.md** integrations auto-section: regenerable `<!-- robin-integrations:start/end -->` block with freshness instructions and per-integration tool list.
- **discord.js v14** added as production dependency.

Phase 2e candidates: Calendar/Drive/YouTube reusing Gmail's OAuth (shared `google.json`); github-write + spotify-write through outbound-policy; headless OAuth device flow; `--code` flag for paste-the-code path.

## [6.0.0-alpha.4] — 2026-05-09

Phase 2c: dream agent + memory shapes + heuristic loop.

- New schema (migration 0005): `knowledge`, `patterns`, `profile` (singleton), `threads`, `rule_candidates`, `rules`. `events.dreamed_at` field added.
- **Dream agent** — daemon-internal periodic batch, heartbeat-scheduled (nightly cron at 4 AM via `process.env.TZ` + event-count overflow trigger). Five-step pipeline: knowledge synthesis → pattern detection → correction clustering → profile inference → thread updates. All LLM calls flow through `host.invokeLLM` subprocess (no direct API).
- **9 new MCP tools** (consolidated from 14): `get_knowledge`, `list_patterns`, `get_profile`, `list_threads`, `list_journal`, `get_hot`, `list_rules(status?)`, `update_rule(id, action, options?)`, `run_dream`. Total daemon surface: 19.
- **8 new CLI commands**: `robin dream run`, `robin rules pending/approve/reject/list/deactivate`, `robin journal`, `robin hot`.
- **Heuristic correction loop**: corrections → 30-day rolling cluster (cosine ≥ 0.85, min 3) → LLM proposes rule → user approves via MCP or CLI → rule active. Profile updates same flow but `kind='profile_update'` with `payload.fields` applied on approval.
- **`rules` table preserves `kind` + `payload`** for replayability of approved profile updates.
- **Heartbeat scheduler** (60s tick) replaces fragile setTimeout — robust to laptop sleep + DST.
- **AGENTS.md** updated with active-rules + pending-rules sections instructing agents to call `list_rules({status: 'active'})` at session start.
- **Task 0**: fixed Phase 2a Claude Code adapter args from stub `['invokeLLM']` to real `claude -p` + JSON output.

Phase 2d (integrations: Gmail, Discord, etc.) is the next phase.

## [6.0.0-alpha.3] — 2026-05-09

Phase 2b followups: zero-friction setup + integration test gaps.

- **`robin install`** — one-command full setup (migrate + mcp install + auto-start + auto-register + auto-supervise).
- **`robin uninstall`** — mirror command (stops daemon, unregisters from hosts, unloads supervisor).
- **`robin mcp install` enhanced:** auto-starts daemon, auto-registers with `claude mcp add` and `gemini mcp add` when those CLIs are on PATH, auto-loads launchd / enables systemd. New flags: `--no-supervise`, `--no-register`, `--no-agents-md`, `--no-start`.
- **Integration test for full install flow** — verifies plist + AGENTS.md generation, plus `plutil -lint` validation of the launchd plist on macOS.
- **Daemon-spawn test timeouts** bumped from 8s to 15s for slow CI runners.
- Graceful degradation when host CLIs / supervisors aren't available.

## [6.0.0-alpha.2] — 2026-05-09

Phase 2b: MCP daemon + agent-facing tools + self-improvement feedback infra.

- New schema (migration 0004): `recall_events` for self-improvement feedback capture.
- `robin-mcp` HTTP+SSE daemon owns the embedded SurrealDB; multi-instance Claude Code safe.
- 10 MCP tools exposed via `@modelcontextprotocol/sdk`:
  - **Memory:** `recall` (with auto-capture into recall_events), `remember`, `run_biographer`.
  - **Graph:** `find_entity`, `get_entity`, `related_entities`.
  - **Episodes:** `list_episodes`.
  - **Daemon:** `health`.
  - **Self-improvement:** `mark_recall_used`, `record_correction`.
- Stop hook routes through daemon when running; falls back to spawn-detached subprocess otherwise.
- Migration coordination: `robin migrate` refuses while daemon is running.
- Daemon supervision generators: launchd plist (macOS) + systemd user unit (Linux).
- AGENTS.md template with feedback section installed by `robin mcp install` (writes to `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md`, append-with-fenced-section to preserve personal content).
- Implicit-signal detection: repeat-query-within-5min flagged in `recall_events.meta`.
- Idle-embedder unloader: 10-minute timeout.
- Version handshake: daemon refuses requests from version-skew CLI.
- New CLI: `robin mcp start/stop/status/restart/ensure-running/install/uninstall`.

Both Claude Code (2.1.138) and Gemini CLI (0.37.1) confirmed to support HTTP/SSE MCP transport — no stdio shim needed.

Phase 2c (dream + memory shapes) is the immediate follow-on.

## [6.0.0-alpha.1] — 2026-05-09

Phase 2a: graph + biographer foundation.

- New schema (migration 0003): `entities` (HNSW indexed at dim 384), `episodes`, 6 edge tables (`mentions`, `about`, `precedes`, `works_on`, `participates_in`, `co_occurs_with`).
- `events.biographed_at` and `events.episode_id` added; migrator-compatible.
- Biographer pipeline: single LLM call per event extracts entities + edges + episode signals; cascade resolution (Stages 1 + 2 + 3) maps mentions to entity records.
- Multi-host adapters: Claude Code subprocess (lifted from v1) + Gemini CLI subprocess (Path A from verification spike). Both with unified `invokeLLM` interface and `cache_control` annotations.
- Multi-host caching: Anthropic ephemeral cache_control on cacheable layers; Gemini CLI manages caching transparently — `cache_read_tokens` surfaced from `stats.models[*].tokens.cached`.
- Fire-and-forget Stop hook: hook spawns detached `robin biographer process-pending` subprocess; agent never waits.
- New CLI: `robin biographer-catchup [--retry-failed]` (foreground manual catchup); `robin biographer process-pending --since <iso>` (subcommand for hooks).
- `runtime:biographer.config` holds tunable thresholds (Stage 2 high/low at 0.92/0.80, episode window 30min, catalog size 100, cooccur cap 8).
- `runtime:host` records detected adapter.
- Failure handling: 3× retry with exponential backoff; failed events tracked in `runtime:biographer.failed_event_ids`; `--retry-failed` revisits them.
- Concurrency: file lock + entity UPSERT with stable IDs + transactional retry; parallel biographer invocations on the same event don't double-create entities.
- Background subprocess output redirected to `~/.robin/logs/biographer.log`.

Phase 2b (MCP server + agent-facing tools) is the immediate follow-on.

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
