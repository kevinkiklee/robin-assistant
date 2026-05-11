# Development

How to work on Robin v2: run tests, extend memory shape, add an integration, add a hook handler, add an embedder profile, add a dream step.

## Test, lint, format

```sh
npm install
npm test                  # node --test on system/tests/**/*.test.js
npm run test:unit
npm run test:integration
npm run lint              # biome check
npm run format            # biome format --write
```

The test runner uses `--test-isolation=process`, so each `*.test.js` file runs as its own subprocess. Tests can use an in-memory SurrealDB (`mem://`) for fast unit tests or a temp `rocksdb://` for integration tests.

## Repo layout

```
system/
  bin/                  robin (the executable) + robin-hook.sh (PATH shim)
  config/               paths.js, data-store.js, file-tail.js, secrets.js
  data/
    db/                 SurrealDB connection + migration runner +
                        migrations/ (0001-init.surql + 0002-embeddings-<profile>.surql)
    embed/              pluggable embedder factory + profile-router + hash
  cognition/
    memory/             store.js (the only writer) + 7 faculty lenses +
                        kind-registry + edge-registry + decay + scopes +
                        episodes + arcs + rules
    intuition/          engine.js (recall) + inject.js + rank.js +
                        fusion.js + reinforcement.js + handler.js
    biographer/         pipeline.js + prompt.js + output.js + queue.js +
                        edges + stage1-exact/stage2-embedding/stage3-disambig
    dream/              step-* pipeline (knowledge, patterns, threads,
                        profile, reflection, comm-style, calibration,
                        scope-cleanup) + candidates.js
    discretion/         outbound-policy + inbound-guard + bash-patterns +
                        pii-patterns + handler.js
    jobs/               builtin manifests + internal job impls + runner
  io/
    capture/            record-event + session-capture + transcript +
                        errors
    hooks/              dispatcher.js (CLI), disabled.js,
                        session-start/stop handlers
    integrations/<name>/ manifest + sync + tool factories + auth helpers
    mcp/                MCP tool definitions
    outbound/           rate limiter + patterns
  runtime/
    cli/                CLI surface (bin.js + commands/)
    daemon/             server, heartbeat (scheduler), sessions,
                        introspection, idle embedder, locks, port file,
                        cadence-consumer
    hosts/              Claude Code + Gemini CLI subprocess adapters
    install/            launchd plist, systemd unit, AGENTS.md generator,
                        hook-shim, hooks-settings, manifest, pre-commit,
                        migrate-home
    scripts/            dev-recall, gen-fixtures, bench-embedder,
                        bench-recall, migrate-fresh,
                        verify-design-assumptions
  tests/                unit/ · integration/ · fixtures/

docs/                   architecture, faculties, install, troubleshooting,
                        development, superpowers/specs (per-phase design)
```

## The mental model: substrate vs. lens

After the v2 redesign there are **only three data tables** — `events`, `memos`, `entities` — plus one generic `edges` table (composite-ID `edges:[kind, from, to]`). Almost every extension is a **code change**, not a schema migration:

| You want to add… | What changes |
|---|---|
| A new memo kind (e.g. `code_edit`) | `MEMO_KIND_REGISTRY` entry + lens module |
| A new edge kind (e.g. `caused_by`) | `EDGE_KIND_REGISTRY` entry |
| A new entity type | Nothing — `entities.type` is open |
| A new event source | Nothing — `events.source` is open |
| A new scope pattern | Constant in `system/cognition/memory/scopes.js` |
| A new embedder profile | `system/data/embed/<name>.js` + `robin embeddings prepare/backfill/activate` |
| A new dream step | `system/cognition/dream/step-<name>.js` + wire into `pipeline.js` |
| A new MCP tool | New file in `system/io/mcp/tools/` + register in `system/runtime/daemon/server.js` |
| A new integration | New `system/io/integrations/<name>/` dir + manifest + sync |
| A new hook handler | New file under `system/cognition/<faculty>/handler.js` or `system/io/hooks/` + DISPATCH map entry |
| A new schema field on `memos`/`events`/`entities` | Real migration (rare; usually goes in `meta.*` instead) |

`meta` is `option<object> FLEXIBLE` on all three substrate tables — extend through `meta.*` rather than adding columns whenever possible. The planner uses field-path indexes on hot `meta.*` keys (e.g. `meta.kind` for events, `meta.external_id` for integrations).

## Adding a new memo kind

The schema's `memos.kind` is an OPEN string; the registry is the in-code source of truth. **No migration is needed.**

1. **Register the kind.** Add an entry to `MEMO_KIND_REGISTRY` in `system/cognition/memory/kind-registry.js`:

   ```js
   code_edit: {
     required: ['content', 'derived_by'],
     dedup_by: 'content_hash',          // optional; events-style hash dedupe
     meta_schema: {
       file_path: 'string!',            // ! = required
       diff_summary: 'string?',         // ? = optional
       lines_changed: 'number?',
     },
   },
   ```

   Unknown kinds are tolerated (open-enum policy) but skip validation; register the kind to get the safety net.

2. **Write the lens.** Create `system/cognition/memory/code-edits.js` (plural noun for the lens module). The lens delegates to `store.note`:

   ```js
   import { note, listMemos } from './store.js';

   export function recordCodeEdit(db, embedder, { filePath, diffSummary, linesChanged, content, lineage = [] }) {
     return note(db, embedder, 'code_edit', {
       content,
       derived_by: 'agent',
       lineage,
       meta: { file_path: filePath, diff_summary: diffSummary, lines_changed: linesChanged },
     });
   }

   export function listCodeEdits(db, opts = {}) {
     return listMemos(db, { kind: 'code_edit', ...opts });
   }
   ```

3. **Add a test.** `system/tests/unit/code-edits-lens.test.js`. Pattern: in-memory DB, fake embedder, call the lens, assert `kind='code_edit'` and `meta.*` shape.

4. **Document it in `faculties.md`** under the relevant lens section (or add a new section if the lens is its own faculty).

## Adding a new edge kind

`edges.kind` is OPEN; the registry enforces endpoint types, self-loop rejection, and symmetric canonicalization at write time. **No migration is needed.**

1. **Register the kind.** Add an entry to `EDGE_KIND_REGISTRY` in `system/cognition/memory/edge-registry.js`:

   ```js
   caused_by: { in: ['events', 'memos'], out: ['events', 'memos'] },
   // or:
   sibling_of: { in: ['entities'], out: ['entities'], symmetric: true },
   // counter edges accumulate `weight` on INSERT RELATION ... ON DUPLICATE KEY UPDATE:
   appeared_with: { in: ['entities'], out: ['entities'], symmetric: true, counter: true },
   ```

   Note: registry keys are `in`/`out` (matching the schema's RELATION-magic fields). Public function parameters on `store.relate` / `validateEdge` keep the `from`/`to` names for caller readability and map internally.

2. **Call `store.relate` from the producer.** Biographer, dream steps, and capture surfaces all go through `store.relate(db, from, to, kind, { fields? })`. Validation happens inside `relate` — invalid endpoints throw.

3. **Add a test.** `system/tests/unit/edge-registry.test.js` (extend the existing) — assert valid endpoints accepted, invalid rejected, self-loops rejected, symmetric kinds canonicalised.

## Graph traversal patterns

The edges table is `TYPE RELATION` (alpha.15+). Three idiomatic ways to walk it, in order of preference for new code:

1. **Arrow traversal with mid-edge filter** — cleanest for single-hop reads, supports recursion natively:
   ```surql
   -- Knowledge memos about an entity:
   SELECT VALUE <-edges[WHERE kind='about']<-memos FROM ONLY entities:alice;

   -- Co-occurring entities within 2 hops:
   SELECT VALUE @ FROM entities:alice.{1..2}->edges[WHERE kind='occurs_with']->entities;
   ```

2. **Indexed `WHERE kind = ... AND in = $id`** — when you also want a non-traversal projection (e.g., `in.name`, `out.ts`):
   ```surql
   SELECT in.name AS a, out.name AS b, weight
   FROM edges WHERE kind = 'occurs_with' AND last_seen >= $cutoff
   ORDER BY weight DESC LIMIT 10;
   ```

3. **Shortest path via JS BFS** — `system/io/mcp/tools/get-entity.js` shows the pattern. SurrealDB v3 has native `{..+shortest=$target}` but it operates on per-table edges; with our single polymorphic table + mid-edge kind filter, BFS in JS is more predictable.

**Writes always go through `store.relate` / `store.relateAll`** — those use `INSERT RELATION ... ON DUPLICATE KEY UPDATE` for idempotent counters. Never write raw `INSERT RELATION` outside `store.js`; the registry validation lives there.

## Time-travel reads (when surrealkv+versioned works)

`@surrealdb/node` 3.0.3 hangs on connect for the versioned engine variant; once upstream fixes that, switching `config.json.db.engine` to `'surrealkv+versioned'` unlocks `SELECT ... VERSION d'<iso>'`. The schema already supports it; no migration needed.

```surql
-- What did Robin believe about $entity on 2026-04-01?
SELECT * FROM memos
WHERE id IN (SELECT VALUE in FROM edges WHERE kind='about' AND out=$entity)
VERSION d'2026-04-01T00:00:00Z';
```

The `supersedes` edges + `fn::freshness` belief-evolution pattern stays useful for *forward recall ranking* even when version-reads are available; the two are complementary (version-reads = audit, supersedes = ranking).

## Adding a new integration

Integrations follow the v1 pattern (the integration-framework guide still applies). Sync functions write to `events` with a consistent `source` + `scope`.

1. **Create the directory.** `system/io/integrations/<name>/`.

2. **Write `manifest.json`** declaring kind, env keys, interval:

   ```json
   {
     "name": "myservice",
     "kind": "sync",
     "interval_minutes": 30,
     "secrets": { "env_keys": ["MYSERVICE_API_KEY"] }
   }
   ```

3. **Write `sync.js`** exporting `async syncOnce({ db, capture, requireSecret, log })`. `capture()` is the framework's hook; it normalises events through `store.remember` (handles content-hash dedupe, embedding into `embeddings_<profile>_events`, inbound discretion). Defaults: `source: '<name>'`, `scope: 'integration:<name>'`, `trust: 'trusted'`. Stash external IDs under `meta.external_id` (not a column).

4. **Optional: tool factories.** Create `tools/<tool-name>.js` exporting `create<Name>Tool({db, requireSecret})` for MCP tools (e.g. `gmail_search`, `linear_create_issue`).

5. **Test.** `system/tests/unit/integrations-myservice-sync.test.js` — mock the external API, call `syncOnce`, assert `events` rows + an `embeddings_<profile>_events` row.

6. **List it in the docs.** Add a row to the integration catalog in [`install.md`](install.md).

## Adding a hook handler

A new hook handler is a thin function invoked by a host-side hook entry. It reads JSON from stdin, optionally calls the daemon, writes one line of stdout or stderr.

1. **Pick or create a hook phase.** Existing phases: `discretion` (PreToolUse Bash), `intuition` (UserPromptSubmit), `session-start` (SessionStart), `stop` (Stop). New phases need an entry in:
   - `system/io/hooks/dispatcher.js` — DISPATCH map (`<phase>: { module, exportName }`)
   - `system/runtime/install/hooks-settings.js` — CLAUDE_PHASES / GEMINI_PHASES arrays (host hook event + matcher + subcommand)

2. **Write the handler.** Faculty-owned phases (e.g. `intuition`, `discretion`) live under `system/cognition/<faculty>/handler.js`. Generic IO phases (e.g. `session-start`, `stop-hook`) live under `system/io/hooks/`. Export an async function taking `{ stdin, stdout, stderr, exit, ... }` for easy testing. Fail-soft on every error path — hooks must not break the host session.

3. **Test.** `system/tests/unit/<phase>-handler.test.js` — pass stdin payload + mock writers, assert stdout/stderr/exit. See `system/tests/unit/discretion-handler.test.js`.

4. **Wire it in via `robin install --hooks-only`.** Re-run after editing `hooks-settings.js` to update `~/.claude/settings.json` and `~/.gemini/settings.json`.

5. **Document the phase.** [`faculties.md`](faculties.md) is the public-facing reference.

## Adding a new MCP tool

MCP tools are agent-facing operations exposed over SSE. Each lives in its own file under `system/io/mcp/tools/`.

1. **Create the tool file.** Convention: a `create*Tool({db, embedder, host, ...})` factory returning `{name, description, inputSchema, handler}`. **All writes go through `system/cognition/memory/store.js`** — no direct CREATE/UPSERT on `events`/`memos`/`entities`/`edges`/embedding tables in tool handlers.

   ```js
   // system/io/mcp/tools/my-tool.js
   import { note, searchMemos } from '../../memory/store.js';

   export function createMyTool({ db, embedder }) {
     return {
       name: 'my_tool',
       description: 'One-line summary the agent will see.',
       inputSchema: {
         type: 'object',
         properties: { query: { type: 'string' } },
         required: ['query'],
       },
       async handler({ query }) {
         const hits = await searchMemos(db, embedder, query, { kind: 'knowledge', limit: 5 });
         return { hits };
       },
     };
   }
   ```

2. **Register it in the daemon.** Add the import + `createMyTool({...})` call to the tool list in `system/runtime/daemon/server.js`. The list is alphabetised for diff clarity.

3. **Test.** `system/tests/unit/my-tool.test.js` — spin up a fresh in-memory DB, seed any rows, call the handler directly. See `system/tests/unit/find-entity.test.js` for a clean template.

4. **Document in AGENTS.md.** Add a line so the agent learns about it on next session start. The `<!-- robin -->` block in `~/.claude/CLAUDE.md` regenerates from `AGENTS.md` on `robin install`.

## Adding a new embedder profile

Profiles are decoupled from the data tables — adding one is a code change plus per-surface DDL, never a substrate migration.

1. **Implement the embedder.** Create `system/data/embed/<name>.js` exporting `create<Name>Embedder()` that returns an `Embedder`:

   ```js
   {
     profile: 'voyage-2048',
     dimension: 2048,
     modelId: 'voyage-3',
     embed: async (text) => Float32Array,    // L2-normalised
     embedBatch: async (texts) => Float32Array[],
     healthCheck: async () => void,          // throws on unreachable
     unload: async () => void,               // optional
   }
   ```

2. **Register the profile.**
   - Add `'voyage-2048'` to `PROFILES` in `system/data/embed/types.js` and the JSDoc `EmbedderProfile` typedef.
   - Add a case to the `switch` in `system/data/embed/factory.js`.
   - Add the profile→dim entry to `PROFILE_DIMENSIONS` and a loader to `PROFILE_LOADERS` in `system/cognition/jobs/embeddings-ops.js`.

3. **Apply on a live system.** With the daemon running:

   ```sh
   robin embeddings prepare voyage-2048    # DDL the three HNSW tables at dim 2048
   robin embeddings backfill voyage-2048   # resumable; safe to interrupt
   robin embeddings activate voyage-2048   # atomic flip; recall switches over
   ```

   The data tables (`events`/`memos`/`entities`) are not touched.

4. **Test.** `system/tests/unit/embed-<name>.test.js` — stub the network call, assert the returned vector shape and normalisation.

## Adding a new dream step

Dream is a sequence of independent, fail-soft steps that run nightly at 4 AM. New steps are additive.

1. **Write `system/cognition/dream/step-<name>.js`** exporting `async dreamStep<Name>(db, host, opts?)`. Steps read events with `dreamed_at IS NONE` (or `biographed_at IS NOT NONE`, depending on what they need) and emit memos via the appropriate lens (`store.note`, `habits.upsert`, `narrative.add`, etc.). Use `host.invokeLLM(messages, { tier: 'deep' })` for LLM calls.

2. **Wire it into `system/cognition/dream/pipeline.js`.** Each step lives in its own `try/catch` so a failure in one doesn't abort the others:

   ```js
   try {
     summary.<name> = await dreamStep<Name>(db, host, opts.<name>);
   } catch (e) {
     summary.<name> = { error: e.message };
   }
   ```

3. **Pick a position in the order.** Knowledge first (emits memos others reference), then patterns/threads (build on memos), then reflection/comm-style/calibration/scope-cleanup (cross-cutting). Order matters: a step can `derived_from` an earlier step's memo.

4. **Test.** `system/tests/unit/dream-step-<name>.test.js` — fake host with canned LLM responses, seed events, run the step, assert memos + edges emitted.

## Adding a schema migration (rare)

Substrate migrations are rare after v2. Most extensions go through registries, `meta.*`, or per-profile embeddings tables. When a real migration is justified (new operational table, new field on a substrate table, new function), follow this:

1. **Pick the next version.** `ls system/data/db/migrations/` — `0002-embeddings-*.surql` are per-profile slots; pick `0003+` for non-embedding work.

2. **Write the migration.** Filename: `00NN-<short-name>.surql`. SurrealDB v3 syntax. Use `FLEXIBLE TYPE object` (in that order — FLEXIBLE comes after TYPE) for forward-compatible meta fields:

   ```surql
   DEFINE TABLE my_op SCHEMAFULL TYPE NORMAL;
   DEFINE FIELD foo  ON my_op TYPE string;
   DEFINE FIELD meta ON my_op TYPE option<object> FLEXIBLE;
   DEFINE INDEX my_op_foo ON my_op FIELDS foo;
   ```

3. **Pre-migration backup.** The runner tars `<robinHome>/db/` into `<robinHome>/cache/backups/<timestamp>.tar` before applying. You don't need to do anything; just be aware your data is safe.

4. **Test.** Migrations are exercised by `system/tests/integration/bootstrap-empty-db.test.js` (full sequence). For schema-specific behaviour, add a test that creates a fresh DB, runs migrations, and asserts the resulting shape.

5. **Apply.** `robin migrate` on the live daemon-stopped instance, or run during `robin install`.

## Conventions

- **No comments unless they explain WHY.** Names should be self-evident. See the top-level `CLAUDE.md` for the full rule set.
- **No fallbacks for impossible states.** Trust internal call sites. Validate only at system boundaries (CLI args, MCP input, external API responses).
- **One writer.** Every persistent state change for memory goes through `system/cognition/memory/store.js` (or a lens that delegates to it). Tool handlers, jobs, dream steps, integration syncs all funnel through. The daemon owns the DB; CLI write commands route through the daemon endpoint when it's running, or take the cooperative file lock when it isn't.
- **Open enums, code-side registries.** `memos.kind`, `entities.type`, `events.source`, `events.trust`, `edges.kind` are unconstrained strings. Adding a value is a registry entry, not a migration.
- **`meta.*` over new columns.** Substrate tables have `meta: option<object> FLEXIBLE`. Extend through `meta.*` (indexable via field-path indexes) instead of adding columns.
- **Cache-aware LLM prompts.** Biographer and dream prompts use `cache_control` annotations on the system-prompt + catalog layers so multi-event batches reuse the cached prefix.

## See also

- [`architecture.md`](architecture.md) — how the pieces fit together
- [`faculties.md`](faculties.md) — the seven named faculties and what they do
- [`troubleshooting.md`](troubleshooting.md) — diagnosing problems
- `docs/superpowers/specs/2026-05-11-robin-v2-database-and-memory-redesign-design.md` — design rationale for the v2 substrate
