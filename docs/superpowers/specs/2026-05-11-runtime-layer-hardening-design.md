# Runtime Layer Hardening + Decomposition

**Status:** Approved design (plan-only; implementation deferred)
**Date:** 2026-05-11
**Predecessors:** Builds on the package restructure in `2026-05-11-robin-v2-package-structure-design.md`. Touches modules under `system/runtime/` (the `runtime` layer defined there).
**Sequencing:** Five phases (R-1 → R-5). Each phase ships as its own PR. R-5 (CLI router) is fully independent and may interleave anywhere.

## 1. Motivation

`system/runtime/` is ~2,900 LoC across `cli/`, `daemon/`, `hosts/`, `install/`, `scripts/`. After the alpha.16 theme work and the package restructure, the layer is functionally complete but has accumulated rough edges:

- **`daemon/server.js` is 990 lines** holding lock acquisition, DB connect, embedder health check, introspection, host detection, biographer queue, integration manifest loading, scheduler wiring, four inline `setInterval` tickers, 17 hand-rolled `/internal/*` HTTP route handlers, MCP transport setup, and shutdown — all in one function.
- **Scheduler/ticker patterns are fragmented.** `heartbeat.js` is a clean injectable scheduler, but three side-band `setInterval` loops and a fourth (session-sweep) live inline in `server.js`. Each has its own try/warn wrapper. The "sleep-resilient" property heartbeat advertises doesn't apply to them.
- **`cli/index.js` is a 295-line if/else router** with small inconsistencies — some subcommand groups use a map, most don't; `Object.values(mod)[0]` magic in three places; help text hand-maintained in a separate `commands/help.js`.
- **`/internal/*` and MCP tools partially overlap** (ingest, lint, audit, intuition exist as both). No request validation, no shared error envelope, no schema.
- **Reliability rough edges**: `lock.js` has a TOCTOU window; no `process.on('uncaughtException'|'unhandledRejection')`; `detectHost()` failure at boot permanently disables the scheduler; embedder health failure hard-exits; heartbeat has no total in-flight cap; `sessions.js` host validator and `hosts/detect.js` adapter keys use different naming conventions.

None of this is broken — tests pass, alpha.16 just shipped. These are refactor and hardening candidates, not bug fixes.

## 2. Design overview

Five phases, each independently shippable to main:

| Phase | What | Risk |
|---|---|---|
| **R-1** | Reliability hardening | low |
| **R-2** | Tiered heartbeat | low |
| **R-3** | Decompose `server.js` + route table | medium |
| **R-4** | Schema + response envelope on `/internal/*` | low |
| **R-5** | Declarative CLI router | low |

**Guardrails (all phases):**

- `npm test` green at every phase boundary, with explicit attention to `system/tests/integration/` daemon boot + session lifecycle tests.
- No new runtime dependencies. The schema validator (R-4) is a ~50-line in-tree util.
- `/internal/*` URLs stay unchanged across all phases.
- `/internal/*` payload shapes are byte-identical through R-3; R-4 adds `ok: true`/`ok: false` to the envelope additively (and renames two semantic `ok` fields — see §6).
- CLI command names, MCP tool names, hook contract, and signal handling are byte-identical to today across all phases.
- R-5 is the only phase that can ship in any order.

**Scope boundary — out of scope:**

- `runtime/install/` (installer, hook-shim, manifest).
- `runtime/scripts/` (dev tools, benchmarks).
- `runtime/hosts/` internals (adapter implementations — only their naming changes in R-1).

## 3. Phase R-1 — Reliability hardening

### 3.1 Targets

**1. Atomic daemon lock** — `daemon/lock.js`

Replace the read-then-write algorithm with a bounded loop using `wx` (exclusive create):

1. `writeFile(path, pid, { flag: 'wx' })` → success, return.
2. On `EEXIST`: read existing PID; `isPidAlive(pid)` → throw `EALREADY`.
3. If dead: `unlink(path)`, loop.

Max 3 iterations. If we loop more than that, multiple daemons are racing through dead-lock cleanup — one of them is genuinely live and we should fail.

**2. Process-level error handlers** — new `daemon/fatal.js`

- `process.on('uncaughtException', onFatal)` and `process.on('unhandledRejection', onFatal)`.
- `onFatal(err)`:
  1. `setTimeout(() => process.exit(1), 5000).unref()` — guarantees exit even if shutdown hangs.
  2. Try-catch around `appendFile('<robin-home>/logs/fatal.log', json + '\n')` — never throw out of the handler.
  3. Log to stderr unconditionally.
  4. Call `shutdown('fatal')` best-effort, then `process.exit(1)`.
- Wired from `startDaemon()` before any other setup so boot crashes get logged.

**3. Host-name normalization** — new `hosts/index.js`, modified `hosts/detect.js`, `daemon/sessions.js`

Canonical hyphenated form: `'claude-code'`, `'gemini-cli'`, `'unknown'` (matches user-visible strings already in `sessions.js`). Rename `ADAPTERS` keys in `hosts/detect.js` from `claude_code`/`gemini_cli` → hyphenated form. New `hosts/index.js` exports:

```js
export const HOSTS = Object.freeze({
  CLAUDE_CODE: 'claude-code',
  GEMINI_CLI:  'gemini-cli',
  UNKNOWN:     'unknown',
});
export const HOST_VALUES = Object.values(HOSTS);
```

`sessions.js` imports `HOST_VALUES` instead of hardcoding the literal triplet. `ROBIN_HOST` env var accepts hyphenated values; underscored values warn once and translate (back-compat for one release).

**4. Embedder health retry** — `daemon/server.js` boot

Wrap `embedder.healthCheck()` in `retryWithBackoff(fn, { attempts: 3, perAttemptTimeoutMs: 10_000, backoffMs: [1000, 4000, 0] })`. Total wall-clock cap: ~35s worst case. Retry uniformly across error kinds — typed embedder errors (which would enable "retry transient only") are a separate follow-up.

**5. Biographer queue depth canary** — `cognition/biographer/queue.js`, `daemon/server.js`

Add `maxPending` (default 1000) to `createBiographerQueue`. When at cap, `enqueue` returns `{ skipped: true }` and logs `[biographer] queue at cap, skipping ${id} (will be picked up next /process-pending)` — no error.

Events stay in the `events` table with `biographed_at IS NONE`; the next `/internal/biographer/process-pending` call picks them up via the same `LIMIT 50` query. The cap is a **canary**, not data protection.

Expose `pendingDepth`, `skippedSinceBoot`, `lastSkippedAt` on the `health` MCP tool.

**6. Scheduler reactivation watchdog** — `daemon/server.js`

If boot-time `detectHost()` returns null, `setInterval(5 * 60_000)` retries detection. On success: start the heartbeat scheduler and cadence ticker (the two host-gated subsystems); clear the watchdog. Stale-episode and action-trust-decay tickers already run unconditionally and don't need reactivation. This watchdog folds into the R-2 bucket model.

### 3.2 Out of scope for R-1 (called out)

- Session-sweeper interval — fine as-is, moves in R-2.
- Inline `await import()` in HTTP handlers — moves in R-3.
- Stale-session auto-purge — opt-in by design, leave alone.
- Typed embedder errors — separate follow-up.

### 3.3 Test strategy

- **New unit**: `daemon/lock.test.js` (concurrent acquire + dead-PID cleanup), `daemon/fatal.test.js` (handler writes log, exits within 5s), `daemon/host-naming.test.js` (canonical form, underscore back-compat warns), `biographer-queue.test.js` (depth canary, no event loss).
- **Updated**: any test using `claude_code`/`gemini_cli` keys → hyphenated.
- **New integration**: boot test with `ROBIN_HOST` unset and no host CLI on PATH confirms watchdog is armed.

### 3.4 Rollout

No DB migration. Lock file content unchanged (still a PID). Existing running daemon must be restarted (`robin mcp restart`) to pick up R-1. Underscored `ROBIN_HOST` keeps working for one release with a warning, removed in a later phase.

### 3.5 Change size

6 files modified, 4 added (3 test files + `fatal.js`/`hosts/index.js`). ~280 LoC delta. Single PR.

## 4. Phase R-2 — Tiered heartbeat

### 4.1 Bucket model

Extend `createScheduler` to take an array of buckets. Each bucket is `{ name, intervalMs, tick, gate?, fireImmediately? }`.

```js
createScheduler({
  buckets: [
    { name: 'dispatcher',     intervalMs: 60_000,        tick: dispatcherTick, fireImmediately: true  },
    { name: 'cadence',        intervalMs: 60_000,        tick: cadenceTick,    gate: () => !!ctx.host },
    { name: 'stale-sessions', intervalMs: 60_000,        tick: () => markStaleSessions(ctx.db) },
    { name: 'stale-episodes', intervalMs: 600_000,       tick: () => closeStaleEpisodes(ctx.db) },
    { name: 'action-decay',   intervalMs: 6 * 3_600_000, tick: () => runActionTrustDecay(ctx.db) },
    { name: 'host-watchdog',  intervalMs: 5 * 60_000,    tick: hostWatchdogTick, gate: () => !ctx.host },
  ],
});
```

**Per-bucket semantics:**

- `tick`: async function. Throws are caught and logged as `[scheduler/${name}] tick failed: ${msg}`.
- `gate` (optional): predicate. If returns false, tick is skipped silently. Gate throws are caught and treated as skip.
- `fireImmediately` (optional, default `false`): fires once at `start()`. Only `dispatcher` sets this — preserves existing boot behavior. Other tickers wait their first interval (matching today).
- Per-bucket `running` flag prevents tick overlap for that bucket.

**Dispatcher fan-out is internal.** The dispatcher tick body fires N runOne calls concurrently with its own `inFlight` Set, then returns. Bucket-level overlap protection doesn't apply to the dispatcher's per-name concurrency — that's intentional.

**Host gating via live closure.** `ctx.host` is a getter backed by a mutable binding. The R-1 watchdog (now a bucket) calls `ctx.setHost(detected)`; gates and ticks read `ctx.host` each tick. No re-registration when host appears.

**Watchdog as a bucket.** R-1's reactivation watchdog becomes the `host-watchdog` bucket. Its tick: `if (!ctx.host) ctx.setHost(await detectHost());`. Gate ensures it only runs while host is null, so it self-cancels after success.

### 4.2 Concrete changes

- `daemon/heartbeat.js`: rewritten to the bucket model. Old `createScheduler({listDue, runOne, isOverflow})` deleted.
- `daemon/server.js`: four inline `setInterval` blocks (cadence, stale-sessions, stale-episodes, action-decay) and the R-1 watchdog `setInterval` deleted; replaced by bucket entries. Dispatcher closure (`baseListDue` + `baseRunOne` + jobs dispatch) named-extracted to `dispatcherTick`.
- Dynamic `await import()` for `cadence-consumer`, `close-stale-episodes`, `action-trust` promoted to top-of-file static imports. R-2 test pass verifies none of these have import-time side effects.
- One `scheduler.stop()` clears every timer at shutdown; the four discrete `clearInterval` calls and their wrapper variables are deleted.

### 4.3 Behavior preserved

- Intervals and tick bodies unchanged.
- Boot timing: only `dispatcher` fires at start; others wait their first interval (same as today).
- Host-gated work skips while no host is detected; activates without restart once one appears.
- Sleep wake: `setInterval` doesn't queue missed ticks on Node — behavior on wake unchanged.

### 4.4 Test strategy

- **New** `heartbeat-buckets.test.js`: multi-bucket independent timers; `stop()` clears all; `gate: false` skips tick; gate throw logged + skipped; tick throw logged + bucket continues; `fireImmediately: true` invokes at start; bucket-level overlap protection.
- **Updated** `heartbeat.test.js`: existing dispatcher assertions adapted to the new entry shape.
- **Integration**: boot test asserts all six buckets armed; a second test boots without host and confirms `dispatcher` + `cadence` skip while `host-watchdog` runs, then simulates host appearing and confirms dispatcher activates on the next minute tick.

### 4.5 Change size

2 files modified (`heartbeat.js`, `server.js`), 1 file added (test). ~150 LoC delta; `server.js` net shrinks by ~80 lines.

## 5. Phase R-3 — Decompose `server.js` + route table

### 5.1 Target file layout

```
daemon/
├── server.js              ~80 lines: thin compose
├── boot.js                ~180 lines: DB, embedder, profile-drift, introspection,
│                                       host, integrations, jobs; returns ctx
├── lifecycle.js           ~100 lines: lock, shutdown, fatal wiring, state, signals
├── tools.js               ~130 lines: buildTools(ctx) → Tool[]
├── http.js                ~100 lines: createServer, JSON body, dispatch, 404, 500
├── routes/
│   ├── index.js           assembles route table from per-domain modules
│   ├── biographer.js      POST /internal/biographer/process-pending
│   ├── session.js         POST /internal/session/{register,end}
│   ├── remember.js        POST /internal/remember
│   ├── jobs.js            POST /internal/jobs/{run,reload}
│   ├── knowledge.js       POST /internal/knowledge/{ingest,lint,audit}
│   ├── actions.js         POST /internal/actions/{set,reset}
│   ├── commstyle.js       POST /internal/comm-style/refresh
│   ├── predictions.js     POST /internal/predictions/resolve
│   ├── calibration.js     POST /internal/calibration/refresh
│   ├── embeddings.js      POST /internal/embeddings/op
│   └── intuition.js       POST /internal/intuition
├── mcp-sse.js             GET /sse — special-cased, not a route-table entry
├── heartbeat.js           from R-2
├── cadence-consumer.js
├── sessions.js
├── lock.js, fatal.js, port.js, idle-embedder.js, introspection.js, version-handshake.js
│   (daemon-state lives at system/config/daemon-state.js — imported from there)
```

### 5.2 `ctx` shape

`boot.js` returns:

```js
{
  version, startedAt,
  db,                       // dbHandle
  embedder: { idle, wrap }, // IdleEmbedder + always-thunk wrapper
  detector,                 // repeat-query detector
  queue,                    // biographer queueWrap
  sessions,                 // { count }
  manifests, registry,      // integrations
  gatewayClients,           // Map<name, client>
  jobs: { cache, refresh },
  capture: { forJobs },
  get host(),               // live (closure over a private binding)
  setHost(h),               // used only by host-watchdog bucket
  log: console.log,
}
```

`_host` lives in a closure inside `boot()` — not in module-level state. `ctx.host` (getter) and `ctx.setHost(h)` are the only access paths.

`buildTools(ctx)` is pure — no module-level state, no side effects. Safe to call from tests against a stub ctx.

### 5.3 Handler signature

```js
// routes/biographer.js
export const biographerRoutes = [
  {
    method: 'POST',
    path: '/internal/biographer/process-pending',
    async handler({ ctx, body, tools }) {
      // ... existing logic
      return { enqueued: pendingRows.length };
    },
  },
];
```

`http.js` is the only place that touches `req`/`res`. It:

1. Matches `method + path` against the table.
2. Parses JSON body (existing `readJsonBody`).
3. Calls `handler({ ctx, body, tools })`. `tools` threaded for the few handlers that look up MCP tools by name (`/internal/knowledge/*`).
4. Success → `200 application/json`, `JSON.stringify(result)`.
5. Thrown error → `500`, `{ error: e.message, name: e.name }` (R-3 preserves; R-4 adds `ok: false` additively).
6. Custom status: handler returns `{ _status, _body, _headers? }` — recognized escape hatch (used by R-1's biographer 207 case).
7. Unmatched route → `404`.
8. `GET /sse` → branches to `mcp-sse.js` (not in the route table).

### 5.4 Lifecycle

`lifecycle.js` owns:

- Lock acquire/release (from R-1).
- Fatal handler wiring (from R-1) — installed before `acquireLock()`. `shutdown` is null-guarded so a fatal during boot doesn't crash trying to stop things that don't exist yet.
- Daemon-state write/clear (from `config/daemon-state.js`).
- Signal handlers (`SIGTERM`, `SIGINT`).
- `shutdown(signal)`: stop scheduler → stop integrations (await each `m.stop`) → close http → close db → clear state → release lock. 10s hard timer is independent of R-1's 5s fatal-path timer.

### 5.5 `server.js` post-decompose

```js
export async function startDaemon() {
  const lifecycle = createLifecycle();
  installFatalHandlers(lifecycle);    // safe pre-lock: shutdown is null-guarded
  await lifecycle.acquireLock();
  try {
    const ctx = await boot(lifecycle);
    const tools = buildTools(ctx);
    const routes = buildRoutes();
    const scheduler = startScheduler(ctx, tools);
    const { httpServer, port } = await startHttp({ ctx, tools, routes });
    await lifecycle.ready({ httpServer, scheduler, port });
    await lifecycle.wait();           // blocks until shutdown
  } catch (e) {
    await lifecycle.fail(e);
    process.exit(1);
  }
}
```

### 5.6 Risks

- **`ctx` shape churn during implementation.** Expected. Each route's `handler({ctx, body, tools})` signature is stable; only ctx's fields may shift. Mitigation: implement domain-by-domain, growing ctx as routes reveal their needs.
- **Shutdown order drift.** Integration test asserts the exact shutdown sequence.
- **Tool-by-name lookup duplication.** `/internal/knowledge/*` and a few others forward to MCP tools by name. Stays as-is in R-3 — fixing requires reshaping factories.
- **Pre-lock fatal crash.** `shutdown` null-guards keep it safe. Test added.
- **Duplicated query.** `events WHERE biographed_at IS NONE` ends up in two places (dispatcher overflow check + biographer route). Noted as future tidy.

### 5.7 Test strategy

- **New unit**: `tools.test.js` (pure ctx → tools array), `route-dispatch.test.js` (match/dispatch/parse/error/`_status`/404), `lifecycle.test.js` (signal triggers shutdown order; fatal pre-lock is safe; double-shutdown no-op).
- **New integration**: `boot.test.js` against a real test DB + stub embedder; asserts ctx fields populated, profile-drift still exits, embedder retries still exhaust.
- **Updated**: tests that imported from `daemon/server.js` retarget to new module paths.
- **Existing integration**: daemon boot, hook lifecycle, MCP tool round-trip pass unchanged.

### 5.8 Commit sequence (single PR)

1. Add `lifecycle.js` extracted from `server.js`.
2. Add `boot.js` returning ctx; `server.js` reduced to lifecycle + boot + still-inline routes.
3. Add `tools.js`; `server.js` reduced further.
4. Add `http.js` + `routes/`; migrate routes one domain at a time within the commit; special-case `/sse` to `mcp-sse.js`.
5. `server.js` final thin compose; delete dead code.

Intermediate commits compile and pass tests, but only commit 5 represents the shipping state.

### 5.9 Change size

`server.js` 990 (post-R-2: ~910) → ~80. ~20 new modules (5 top-level extracts + 11 route files + `mcp-sse.js` + `routes/index.js`) + 3 new test files. Move-heavy: ~120 LoC genuinely new (route dispatcher, ctx wiring, tests).

## 6. Phase R-4 — Schema + envelope on `/internal/*`

### 6.1 Envelope shape

```js
// success — envelope's ok always wins
const body = Object.assign({}, result, { ok: true });
// → { ok: true, ...result }

// error
{ ok: false, error: 'message', name: 'ErrorName', validation?: [...] }
```

Spread (not nesting under `data`) preserves every existing in-tree caller that reads body fields directly. New callers can additionally pattern-match on `ok`.

Envelope's `ok: true` always wins on the success path — handlers signal failure by throwing, not by returning `ok: false`.

### 6.2 Pre-migration: free up the `ok` field

Three routes currently return semantic `ok` that collides with the envelope:

- `/internal/actions/set`: `{ ok: true, class, state }` → `{ class, state }` (200 IS the success signal).
- `/internal/actions/reset`: `{ ok: true, class, state: 'ASK' }` → `{ class, state: 'ASK' }`.
- `/internal/jobs/run`: `{ ok: after.last_run_ok === true, last_error }` → `{ succeeded: after.last_run_ok === true, last_error }`.

Pre-R-4 commit: grep `body.ok` and `result.ok` across the repo. Touchpoints expected: `system/runtime/cli/commands/actions-*.js`, `system/runtime/cli/commands/jobs-run.js`, and tests. Updated in the same PR.

### 6.3 Schema validator

New file `daemon/schema.js` (~50 LoC). Vocabulary:

```
string | string? | number | number? | integer | integer? | boolean | boolean?
| array | array? | object | object?
```

`?` suffix means optional. Strict — unknown fields rejected. Aliases (`session_id` ↔ `sessionId`) declared explicitly. No enum/regex/range vocabulary; semantic checks stay in handlers.

```js
{
  method: 'POST',
  path: '/internal/remember',
  schema: { content: 'string', source: 'string?', meta: 'object?', force: 'boolean?' },
  async handler({ ctx, body }) { /* ... */ },
}
```

Validator returns `{ ok: true, value } | { ok: false, errors: [{ path, message }] }` (internal shape — doesn't collide with the HTTP envelope).

### 6.4 Per-route schemas (just the four that already validate)

- `/internal/remember`: `{ content: 'string', source: 'string?', meta: 'object?', force: 'boolean?' }`.
- `/internal/jobs/run`: `{ name: 'string', force: 'boolean?' }`.
- `/internal/actions/set`: `{ class: 'string', state: 'string' }` (enum check stays inline).
- `/internal/actions/reset`: `{ class: 'string' }`.

Routes without schemas keep their current permissive behavior.

### 6.5 Dispatcher additions to `http.js`

About 15 LoC on top of R-3:

1. `try { JSON.parse(raw) } catch` → `400 { ok: false, error: 'invalid JSON body', name: 'RobinInvalidJsonError' }`.
2. If route has `schema`, run validator before handler; failure → `400 { ok: false, error: 'invalid request body', name: 'RobinValidationError', validation: errors }`.
3. Success path: `Object.assign({}, result, { ok: true })`.
4. Thrown error: `{ ok: false, error: e.message, name: e.name }`.
5. `_status`/`_body` escape hatch bypasses envelope-wrap entirely.

### 6.6 What R-4 deliberately does NOT do

- Does not change URLs.
- Does not change success status codes (still 200; adds 400 only for new validation failures).
- Does not deduplicate the `tools.find(t => t.name === 'ingest')` forwarding routes.
- Does not validate response shapes — request-only.

### 6.7 Test strategy

- **New** `schema.test.js`: every type vocabulary entry; required vs optional; strict unknown-field rejection; alias declarations; nested object validation; error shape.
- **New** `envelope.test.js`: success spread; envelope's `ok: true` overrides handler's `ok: false`; `_status` bypass; error envelope shape; validation envelope shape; invalid-JSON error shape.
- **Updated**: `/internal/actions/*` and `/internal/jobs/run` route tests assert renamed fields (`succeeded` not `ok`); CLI command readers updated.
- **Integration**: stop hook, session register, intuition endpoint receive their expected fields plus `body.ok === true`.

### 6.8 Rollout

Single PR. Daemon and in-tree callers ship together. No installed-hook surgery — hook shims call `robin <cmd>`, which resolves to the upgraded package.

### 6.9 Change size

~200 LoC delta: `http.js` +15, `daemon/schema.js` +50, per-route schemas ~50, tests ~80, semantic-`ok` renames ~10. `server.js` unchanged from R-3.

## 7. Phase R-5 — Declarative CLI router

### 7.1 Registry

`cli/commands.js` is the single source of truth. Every leaf declares `{ import, export, help? }`. Groups declare `{ subcommands, help? }`. Recursive shape supports `integrations discord register-commands` without special-casing.

```js
export const commands = {
  install:   { import: './commands/install.js',   export: 'install',   help: 'install Robin' },
  uninstall: { import: './commands/uninstall.js', export: 'uninstall', help: 'uninstall Robin' },
  // ...
  mcp: {
    help: 'daemon control',
    subcommands: {
      start:            { import: './commands/mcp-start.js',          export: 'mcpStart' },
      stop:             { import: './commands/mcp-stop.js',           export: 'mcpStop' },
      // ...
    },
  },
  integrations: {
    help: 'integration management',
    subcommands: {
      list:   { import: './commands/integrations-list.js',   export: 'integrationsList' },
      status: { import: './commands/integrations-status.js', export: 'integrationsStatus' },
      run:    { import: './commands/integrations-run.js',    export: 'integrationsRun' },
      discord: {
        help: 'discord-specific',
        subcommands: {
          'register-commands': {
            import: './commands/integrations-discord-register.js',
            export: 'integrationsDiscordRegister',
          },
        },
      },
    },
  },
};
```

`export` is required on every leaf. The current `Object.values(mod)[0]` magic (used by ~7 command files today) is dropped. Audit pass during implementation: grep + read those files to capture their actual export names.

**Help ordering is registry insertion order.** Object key order is insertion-stable in modern JS.

### 7.2 Dispatcher

`cli/index.js` shrinks to ~55 lines:

```js
import { commands } from './commands.js';
import { help } from './commands/help.js';
import { version } from './commands/version.js';

export async function main(argv) {
  const head = argv[0];
  if (head === '--version' || head === '-v') return version();
  if (!head || head === '--help' || head === '-h') return help(commands);
  return dispatch(commands, argv);
}

async function dispatch(node, argv) {
  const [head, ...rest] = argv;
  const entry = node[head];
  if (!entry) {
    console.error(`unknown command: ${head}`);
    console.error('run `robin --help` for usage');
    process.exit(1);
  }
  if (entry.subcommands) {
    if (!rest[0]) {
      console.error(`usage: <${Object.keys(entry.subcommands).join('|')}>`);
      process.exit(1);
    }
    return dispatch(entry.subcommands, rest);
  }
  const mod = await import(entry.import);
  const fn = mod[entry.export];
  if (typeof fn !== 'function') {
    throw new Error(`registry: ${entry.import} has no export ${entry.export}`);
  }
  return fn(rest);
}
```

### 7.3 Auto-generated `--help`

`commands/help.js` rewritten as a small recursion over the registry, formatted as columns:

```
robin <command> [args]

Commands:
  install              install Robin (hooks, MCP, daemon)
  uninstall            uninstall Robin
  migrate              apply schema migrations
  ...
  mcp <subcommand>     daemon control
    start, stop, status, restart, ensure-running, install, uninstall
  integrations <subcommand>     integration management
    list, status, run
    discord <subcommand>     discord-specific
      register-commands
```

The README's "Command reference" duplicates this. Out of R-5 scope; future tidy could replace it with a pointer to `robin --help`.

### 7.4 Per-command help

Out of R-5 scope. Each command function still owns its own `--help`. The dispatcher does NOT intercept `--help` in leaf positions.

### 7.5 Test strategy

- **New** `cli/commands.test.js`: actually `import()` every leaf module (path-resolution alone misses the export check); collect all failures into one assertion and report as a list.
- **New** `cli/dispatch.test.js`: leaf dispatch calls the right export with `argv.slice(N)`; group + missing subcommand prints usage and exits 1; recursive group dispatch; unknown command exits 1.
- **Snapshot** `cli/help.test.js`: golden file for the rendered `--help` output.

### 7.6 Migration steps (single PR)

1. Audit the ~7 command files dispatched by `Object.values(mod)[0]` — record their actual export names.
2. Add `cli/commands.js` with all entries. Add coverage test.
3. Add new `cli/index.js` (dispatcher). Old body deleted in the same commit.
4. Rewrite `cli/commands/help.js` to walk the registry.
5. Run `npm test` — all command-level integration tests pass without changes.

### 7.7 Behavior preserved

- Every existing `robin <cmd>` and `robin <cmd> <sub>` invocation runs identically.
- Help text shape changes (now data-driven) — acceptable, no test or caller depends on the exact string.
- Exit codes unchanged.

### 7.8 Edge cases handled

- `robin biographer` with no subcommand: prints `usage: <process-pending>` and exits 1 (today: `unknown biographer subcommand: undefined`). Slight wording improvement, same exit code.
- `robin pre-commit run` exists in today's subcommand map though not in the README. Stays in the registry.
- `robin hook <phase>`: single command, no group. Argv passes through.

### 7.9 Change size

`cli/commands.js` +130; `cli/index.js` net delete ~240 (295 → ~55); `commands/help.js` +60 rewrite; tests +120. Net delete ~100 LoC overall. Single PR.

## 8. Cross-phase summary

| Phase | Files touched | Net LoC | Risk |
|---|---|---|---|
| R-1 | 6 mod, 4 new | +280 | low |
| R-2 | 2 mod, 1 new | +150 (server.js −80; heartbeat.js +80; test +150) | low |
| R-3 | 1 large mod, ~20 new | +120 net (move-heavy; ~120 genuinely new) | medium |
| R-4 | ~6 mod, 1 new | +200 | low |
| R-5 | 2 mod, 2 new | −100 | low |
| **total** | | **~+650** | |

`server.js` 990 → ~80. `cli/index.js` 295 → ~55.

**Surface changes:**

- **Byte-identical** across all phases: hook contract (`robin hook <phase>`), CLI command names, MCP tool names, `/internal/*` URLs, signal handling.
- **Additive-only** (R-4): `/internal/*` success responses gain `ok: true`; error responses gain `ok: false`. Existing fields preserved.
- **Renamed** (R-4): `/internal/actions/*` drop their semantic `ok` field; `/internal/jobs/run` renames `ok` → `succeeded`. In-tree callers updated in the same PR.

## 9. Sequencing and risk

R-1 → R-5 in order; R-5 can interleave anywhere. Each phase ships to main as its own merge and gets dogfood time before the next phase begins (this is daily-use Robin).

R-1 is independently valuable (atomic lock + process error handlers alone justify the merge). R-2 is a small move. R-3 is the riskiest because of the `ctx` shape design, but every external interface is preserved. R-4 is additive on top of R-3's route table. R-5 is fully independent.

## 10. Open questions for the implementation plan

1. **Embedder retry wall-clock cap (~35s).** Acceptable for cold Ollama starts, or push the per-attempt timeout up?
2. **Biographer queue cap default (1000).** Sane for typical event volumes, or tune?
3. **R-3 implementation order within the PR.** Lifecycle → boot → tools → routes/http → final compose is recommended; deviations possible if route migration reveals a different natural order.
4. **R-5 timing.** Independent of the rest. Could ship first as a quick win, or last as a cleanup, or interleaved.

## 11. See also

- `docs/architecture.md` — current daemon + scheduler shape.
- `docs/superpowers/specs/2026-05-11-robin-v2-package-structure-design.md` — the `runtime/` layer's location and intent.
- `docs/superpowers/specs/2026-05-11-robin-v2-theme-3-cognition-cadence-design.md` — cadence consumer that R-2 folds into a bucket.
- `docs/superpowers/specs/2026-05-11-robin-v2-theme-4-observability-design.md` — introspection MCP tools that route alongside `/internal/*`.
