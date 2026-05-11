# Development

How to work on Robin: run tests, add an MCP tool, add an integration, add a hook handler, add a migration.

## Test, lint, format

```sh
npm install
npm test                  # node --test on tests/**/*.test.js
npm run test:unit
npm run test:integration
npm run lint              # biome check
npm run format            # biome format --write
```

The test runner uses `--test-isolation=process`, so each `*.test.js` file runs as its own subprocess. Tests can use an in-memory SurrealDB (`mem://`) for fast unit tests or a temp `rocksdb://` for integration tests.

## Repo layout

```
src/
  schema/migrations/    .surql migrations (0001–0012)
  db/                   SurrealDB connection + migration runner
  embed/                pluggable embedder factory (mxbai / qwen3 / gemini)
  capture/              recordEvent + biographer + conversation-capture
  recall/               HNSW search + intuition endpoint
  graph/                cascade.js, edges, episodes, Stage 1–3 resolvers
  dream/                5-step nightly pipeline + prompts
  rules/                rule_candidates → rules promotion
  memory/               knowledge / patterns / profile / threads readers
  hosts/                Claude Code + Gemini CLI subprocess adapters
  daemon/               server, scheduler, biographer queue, sessions,
                        introspection, idle embedder, locks, port file
  mcp/                  MCP tool definitions
  hooks/                bash-patterns, pii-patterns, inbound-guard,
                        cli dispatcher, disabled.txt reader,
                        handlers/ (discretion, intuition,
                                   session-start, stop-hook)
  integrations/<name>/  manifest + sync + tool factories + auth helpers
  outbound/             discretion (outbound) + rate limiter + patterns
  secrets/              .env layer + atomic writes
  install/              launchd plist, systemd unit, AGENTS.md generator,
                        hook-shim, hooks-settings, manifest, pre-commit
  cli/commands/         CLI surface
  runtime/              ROBIN_HOME bootstrap, paths, runtime config

bin/                    robin (the executable) + robin-hook.sh (PATH shim)
scripts/                dev-recall.js, gen-fixtures.js, bench-embedder.js
tests/                  unit/ · integration/ · fixtures/
docs/                   architecture, faculties, install, troubleshooting,
                        development, superpowers/specs (per-phase design)
```

## Adding a new MCP tool

MCP tools are agent-facing operations exposed over SSE. Each lives in its own file under `src/mcp/tools/`.

1. **Create the tool file.** Convention: a `create*Tool({db, embedder, host, ...})` factory that returns `{name, description, inputSchema, handler}`.

   ```js
   // src/mcp/tools/my-tool.js
   export function createMyTool({ db }) {
     return {
       name: 'my_tool',
       description: 'One-line summary the agent will see.',
       inputSchema: {
         type: 'object',
         properties: {
           query: { type: 'string' },
         },
         required: ['query'],
       },
       async handler({ query }) {
         const [rows] = await db
           .query(surql`SELECT ... WHERE ... = ${query}`)
           .collect();
         return { results: rows };
       },
     };
   }
   ```

2. **Register it in the daemon.** Add the import + the `createMyTool({...})` call to the tool list in `src/daemon/server.js`. The list is alphabetised for diff clarity.

3. **Test.** Add `tests/unit/my-tool.test.js`. Pattern: spin up a fresh in-memory DB, seed any rows the tool reads, call the handler directly. See `tests/unit/find-entity.test.js` for a clean template.

4. **Document in AGENTS.md.** Add a line so the agent learns about it on next session start. The `<!-- robin -->` block in `~/.claude/CLAUDE.md` regenerates from `AGENTS.md` on `robin install`.

## Adding a new integration

There are three integration kinds (`sync`, `gateway`, `tool-only`). Most new integrations are `sync` — heartbeat-driven pulls. The `_framework/` directory holds the shared scaffolding.

1. **Create the directory.** `src/integrations/<name>/`.

2. **Write `manifest.json`.** Declares kind, env keys it needs, interval, optional preflight.

   ```json
   {
     "name": "myservice",
     "kind": "sync",
     "interval_minutes": 30,
     "secrets": { "env_keys": ["MYSERVICE_API_KEY"] }
   }
   ```

3. **Write `sync.js`** exporting an `async syncOnce({ db, capture, requireSecret, log })` function. `capture()` is the framework's hook into `recordEvent` (handles content-hash dedupe, embedding, inbound discretion). Use `requireSecret()` to pull env keys without touching `process.env`. The framework gives you a `cursor` from `runtime_integrations` and writes back the new one on success.

4. **Optional: tool factories.** Create `tools/<tool-name>.js` exporting a `createMyserviceFoo({db, requireSecret})` factory if the integration exposes MCP tools (e.g. `gmail_search`, `linear_create_issue`).

5. **Test.** `tests/unit/integrations-myservice-sync.test.js`. Pattern: mock the external API with a fake fetch, call `syncOnce`, assert event rows. See `tests/unit/integrations-gmail-sync.test.js`.

6. **List it in the docs.** Add a row to the integration catalog in [`install.md`](install.md) and a line to the `<!-- robin -->` block template.

## Adding a hook handler

A new hook handler is a thin function invoked by a host-side hook entry. The handler reads JSON from stdin, optionally calls the daemon, writes one line of stdout or stderr.

1. **Pick or create a hook phase.** The existing phases are `discretion` (PreToolUse Bash), `intuition` (UserPromptSubmit), `session-start` (SessionStart), `stop` (Stop). A new phase needs an entry in:
   - `src/hooks/cli.js` — DISPATCH map (`<phase>: { module, exportName }`)
   - `src/install/hooks-settings.js` — CLAUDE_PHASES / GEMINI_PHASES arrays (host hook event + matcher + subcommand)

2. **Write the handler.** `src/hooks/handlers/<phase>.js`. Export an async function taking `{ stdin, stdout, stderr, exit, ... }` for easy testing. Fail-soft on every error path — hooks must not break the host session.

3. **Test.** `tests/unit/<phase>-handler.test.js`. Pattern: pass stdin payload + mock writers, assert the handler's stdout/stderr/exit calls. See `tests/unit/discretion-handler.test.js`.

4. **Wire it in via `robin install --hooks-only`.** Re-run after editing `hooks-settings.js` to update the user's `~/.claude/settings.json` and `~/.gemini/settings.json`.

5. **Document the phase.** [`faculties.md`](faculties.md) is the public-facing reference. Add a section if it's a named faculty; otherwise mention it in the relevant existing faculty.

## Adding a schema migration

Migrations are hand-written `.surql` files under `src/schema/migrations/`. The runner applies any unapplied versions in numeric order and records each in `_migrations`. Each migration is verified by checksum on subsequent boots.

1. **Pick the next version.** Inspect `ls src/schema/migrations/` — the highest number is the current head. Use that + 1.

2. **Write the migration.** Filename: `00NN-<short-name>.surql`. Use SurrealDB v3 syntax:

   ```surql
   -- Phase X: short description
   DEFINE TABLE my_table SCHEMAFULL TYPE NORMAL;
   DEFINE FIELD foo ON my_table TYPE string;
   DEFINE INDEX my_table_foo ON my_table FIELDS foo;
   ```

3. **Pre-migration backup.** The runner tars `<robinHome>/db/` into `<robinHome>/backups/<timestamp>.tar` before applying. You don't need to do anything; just be aware your data is safe.

4. **Test.** Migrations are exercised by `tests/integration/bootstrap-empty-db.test.js` (full sequence) and the migration-runner tests in `tests/integration/`. For schema-specific behaviour, add a test that creates a fresh DB, runs migrations, and asserts the resulting shape.

5. **Apply.** `robin migrate` on the live daemon-stopped instance, or run during `robin install`.

### Profile-specific migrations

Embedder profiles ship as `0008-embedder-<profile>.surql` variants. The runner applies only the variant matching the configured profile. To add a new embedder profile, write `0008-embedder-<name>.surql` with the right HNSW dimension and update the install picker in `src/cli/commands/install.js`.

## Embedder

Embedders implement a single contract:

```js
{
  profile: 'mxbai-1024',
  dim: 1024,
  embed: async (text) => Float32Array,   // L2-normalised
  healthCheck: async () => void,         // throws on unreachable
}
```

The factory is `src/embed/factory.js`. To add a new embedder, write `src/embed/<name>.js`, register it in the factory, and add an `0008-embedder-<name>.surql` migration with the matching HNSW dim.

## Conventions

- **No comments unless they explain WHY.** Names should be self-evident. See the top-level `CLAUDE.md` for the full rule set.
- **No fallbacks for impossible states.** Trust internal call sites. Validate only at system boundaries (CLI args, MCP input, external API responses).
- **Single write primitive.** Every persistent state change for memory goes through `recordEvent` (which embeds, dedupes, and runs inbound discretion).
- **The daemon owns the DB.** CLI commands that need write access route through the daemon when it's running, or take the cooperative file lock when it isn't.
- **Cache-aware LLM prompts.** Biographer and dream prompts use `cache_control` annotations on the system-prompt + catalog layers so multi-event batches reuse the cached prefix.

## See also

- [`architecture.md`](architecture.md) — how the pieces fit together
- [`faculties.md`](faculties.md) — the seven named faculties and what they do
- [`troubleshooting.md`](troubleshooting.md) — diagnosing problems
