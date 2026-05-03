# E2E Test Harness for the Robin CLI Package

**Date:** 2026-05-03
**Scope:** `robin-assistant/` (the npm package source tree at the repo root). The Next.js web app under `robin-assistant-app/` is out of scope — it has its own Playwright suite.
**Goal:** Refactor confidence. Build a black-box-ish harness that locks behavior at well-defined boundaries so internals (capture pipeline, hook layer, memory ops, jobs runner) can be rewritten freely.

## Context

The CLI package today has 108 unit-style tests under `system/tests/` using `node:test`. There is no end-to-end layer — no spawn-the-binary tests, no hook-integration tests, no install/postinstall tests, no protocol-flow tests against fixture user-data.

The user's stated goal is **refactor confidence**: be able to rip out and rewrite internals (capture, dream, memory ops) and have a high-level harness say the contract still holds. That goal pushes the harness toward a single, broadly-applicable shape rather than ad-hoc tests per subsystem.

`dream` and other agent-driven jobs (`runtime: agent`) are *not* e2e-testable without stubbing the model itself — their inbox routing happens inside an agent turn, not in package code. The harness covers what's deterministic; agent-driven flows remain at the unit level via their deterministic helpers (handoff writer, keyword scanner, recall lib, prefilter, classify).

## §1 — Architecture

### Deterministic vs. agent-driven — scope foundation

The harness covers **deterministic** flows: given the same fixture inputs and frozen environment, the same outputs are produced byte-for-byte. **Agent-driven** flows (`runtime: agent` jobs like `dream`, `daily-briefing`, `email-triage`, `weekly-review`) are out of scope because their outputs depend on the model's response inside an agent turn, not on package code. Their deterministic helpers (handoff writer, keyword scanner, recall lib, prefilter, classify) remain unit-tested today and are exercised transitively via the hooks scenarios in §5. This framing drives every downstream decision (which subsystems are covered, what stubs we need, what's deferred).

### Layout — scenarios are self-contained

```
system/tests/
  e2e/                            ← new: scenario-based e2e suites
    hooks/<scenario>.test.js          ← default mode='subprocess'
    memory/<scenario>.test.js
    jobs/<scenario>.test.js
    install/<scenario>.test.js        ← always mode='subprocess'
  fixtures/                       ← new: one dir per scenario, fully self-contained
    <subsystem>/<scenario>/
      input/                      ← seed user-data tree, copied to tempdir
      expected/tree/              ← MIRROR of expected user-data, normalized text
      expected/io.snapshot.json   ← opt-in
      expected/network.json       ← opt-in
  lib/                            ← new harness internals
    scenario.js                   ← runScenario({ fixture, steps, mode, expect })
    snapshot.js                   ← capture/diff trees, UPDATE_SNAPSHOTS=1
    fixtures.js                   ← copy fixture → tempdir; lifecycle below
    normalize.js                  ← deterministic transforms; example-driven
    clock.js                      ← Date.now / random / ID injection
    stubs.js                      ← outbound mocks + network-block guard
  …existing 108 unit tests stay where they are; e2e is a layer above…
```

### Scope boundary — what e2e tests, what they don't

E2e covers **system-side** flows: `bin/`, `system/scripts/`, hooks, jobs in `system/jobs/`, skeleton templates in `system/scaffold/`. It does **not** cover code under `user-data/runtime/scripts/` — that's per-user, gitignored, not packaged. Outbound integrations are stubbed at the in-repo adapter layer (`system/scripts/sync/lib/`, `system/scripts/discord/`).

### Two run modes, one API

```js
await runScenario({
  fixture: 'memory/recall-multi-entity',
  clock: '2026-05-02T12:00:00Z',
  steps: [
    { hook: 'on-stop', stdin: { session_id: 'test-1', /*…*/ } },
    { run: ['recall', 'Alice', '--json'] },
  ],
  expect: { tree: true, io: false, network: false },
});

await runScenario({ /* … */ mode: 'subprocess' });
```

**Mode defaults (per subsystem, not global):**
- `memory/`, `jobs/` → default `inproc` (fast).
- `hooks/` → default `subprocess`. The hook contract is *exit-code-2 + stderr surfaced to the model*, and stderr capture is best-effort in inproc.
- `install/` → always `subprocess`. Postinstall runs as part of npm install; no inproc analog.

### Boundary contract

1. **Tree** — filesystem state under `user-data/`. Always asserted.
2. **IO** — per-step exit code (always); normalized `console.*` (always in subprocess; **best-effort** in inproc). Strict stdout/stderr assertions: `expect.io: true` + force `mode: 'subprocess'`.
3. **Network ledger** — recorded `{method, host, path}` calls. **Default: any unstubbed network attempt fails the test.** Asserting ledger contents against `expected/network.json` is opt-in via `expect.network: true`. Block enforcement is on the harness side: every block is recorded, and the scenario fails at end if any block events exist — even when Robin's code caught the throw.

### Normalization (example-driven, extensible)

Applied left-to-right, idempotent:
1. Strip ANSI escapes; LF-normalize line endings.
2. Replace temp workspace prefix with `<WS>`.
3. Collapse ISO timestamps within ±1 day of `clock` to `<TS>`.
4. Per-scenario `normalize: [{from, to}]` last (regex+replacement).

Both actual output and snapshot writes go through the same pipeline.

### Tempdir lifecycle

Each test gets `os.tmpdir()/robin-e2e-<uuid>/`. Success → deleted; failure → retained, path printed to stderr; `KEEP_TEMPDIRS=1` retains all.

### Required upstream changes

- **`bin/robin.js`** — extract `main(argv, env): Promise<{exitCode}>`. Subcommands' direct `process.exit(n)` calls become `throw new ExitSignal(n)`, caught by `main`. The file's bottom becomes a portable shell guard:
  ```js
  import { fileURLToPath } from 'node:url';
  import { realpathSync } from 'node:fs';
  const isMain = process.argv[1]
    && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  if (isMain) {
    main(process.argv.slice(2), process.env)
      .then(({ exitCode }) => process.exit(exitCode))
      .catch(err => { console.error(err); process.exit(1); });
  }
  ```
  `realpathSync` handles npm bin symlinks.

- **`system/scripts/hooks/claude-code.js`** — extract `runHook(mode, { stdin, env, workspace }): Promise<{exitCode}>` from the top-level body; same shell-guard pattern.

- **`process.exit` strategy — hybrid (91 sites across 23 files):**
  - The two entry shells (`bin/robin.js`, `claude-code.js`) get explicit `ExitSignal`-throwing rewrites — ~5–10 sites total.
  - The remaining ~80 sites (deep in `system/scripts/{capture,memory,jobs,sync,…}`): the inproc harness installs a scoped `process.exit` monkey-patch on `runScenario` entry that throws `ExitSignal(code)`, restored on exit. `ExitSignal` extends `Error`; the harness logs "swallowed exit signal" diagnostics if no outer catch fires.

- **Audit entry-point scripts** for hardcoded `import.meta.url`-derived paths that ignore `ROBIN_WORKSPACE`. Most respect it; audit catches stragglers.

### Inproc stdout/stderr capture — explicit caveat

The harness installs a custom `Console` for `console.*` (reliably captured). Direct `process.stdout.write` calls go through a `_write` patch but are **best-effort** — third-party modules can cache stream references. Scenarios needing strict stdout assertions declare `mode: 'subprocess'`. Tree assertions (the primary contract) work identically in both modes.

### Mode parity caveats

- Inproc wraps the call in stream redirection + `ExitSignal`-trapping `try/catch` + `process.exit` monkey-patch.
- `child_process.spawnSync` and `process.kill` escape inproc → subprocess is the right mode.
- Subprocess mode is mandatory for postinstall.

### Postinstall — single heavyweight scenario

`npm pack` once per CI run, `npm install` the tarball into the tempdir. ~5–10s. Budget exactly **one** install scenario covering fresh install. User-data version migrations are covered at the migration-script unit-test level — no permanently-maintained historical fixture trees.

## §2 — Scenario format

A scenario is a `.test.js` file calling `runScenario` with a fixture name, steps, and what to assert.

### Test file shape

```js
// system/tests/e2e/memory/recall-multi-entity.test.js
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: memory: recall finds multi-entity references', () => {
  it('returns all hits in stable order', async () => {
    await runScenario({
      fixture: 'memory/recall-multi-entity',
      clock: '2026-05-02T12:00:00Z',
      steps: [{ run: ['recall', 'Alice', '--json'] }],
      expect: { tree: true, io: true },
    });
  });
});
```

`describe` blocks are prefixed with `e2e:` so the `test:unit` script can exclude e2e via `--test-name-pattern='^(?!e2e:)'`.

### Fixture / expected layout (mirror tree)

```
system/tests/fixtures/memory/recall-multi-entity/
  input/user-data/…                  ← seeded into tempdir as-is
  expected/
    tree/user-data/…                 ← mirror of expected user-data, normalized text
    io.snapshot.json                 ← only when expect.io: true
    network.json                     ← only when expect.network: true
```

`fixture: 'memory/recall-multi-entity'` resolves to `system/tests/fixtures/memory/recall-multi-entity/`.

### Skeleton seeding

Default: harness seeds `<tempdir>/user-data/` with `input/user-data/` only — no implicit skeleton copy. Scenarios that need skeleton-shaped user-data declare `seed: 'scaffold'`, which copies `system/scaffold/` first then overlays `input/`. Install and first-run scenarios use `seed: 'none'` (the default) because they're testing skeleton creation.

### Expected-tree completeness rule

`expected/tree/` is the **full** expected output, not a diff against `input/`. Every file Robin should leave in the tempdir at scenario end must appear under `expected/tree/`, even unchanged seed files. `UPDATE_SNAPSHOTS=1` generates the full tree automatically; authors don't write expected files by hand. Authors reading a fixture see exactly what the scenario expects on disk without overlaying input + diff.

### Volatile-path ignore list

```js
const DEFAULT_TREE_IGNORE = [
  'user-data/runtime/state/telemetry/**',
  'user-data/runtime/state/jobs/**/*.lock',
  'user-data/runtime/state/jobs/**/*.tmp',
  '**/.DS_Store',
];
```

Per-scenario extension: `expect: { tree: { ignore: ['user-data/runtime/state/foo/**'] } }`. Explicit listings in `expected/tree/` always win over ignore globs.

### Step verbs

| Verb | Shape | Effect |
|---|---|---|
| `run` | `{ run: [args…], env?: object, expectExit?: number }` | Calls `main(args, env)`. Default `expectExit: 0`. `env` overlays for this step only. |
| `hook` | `{ hook: '<mode>', stdin?: object, env?: object, expectExit?: number }` | Calls `runHook(mode, …)`. `<mode>` is whatever the hook script's arg parser accepts (e.g., `on-stop`, `on-pre-tool-use`, `on-pre-bash`, `on-session-start`). |
| `writeFile` | `{ writeFile: 'user-data/path', content: '…' }` | Writes a file inside the tempdir to simulate user editing mid-scenario. |

That's the entire vocabulary. No `setEnv`, `wait`, `if/then`. If a scenario needs more, split it.

When a step has `expectExit: <non-zero>`, the tree is still asserted afterward — that's how "blocking hook leaves state unchanged" scenarios work.

### Update workflow (symmetric)

```sh
UPDATE_SNAPSHOTS=1 node --test system/tests/e2e/memory/recall-multi-entity.test.js
```

When set, the harness *writes* `expected/tree/`, `io.snapshot.json`, and `network.json` from the actual run (post-normalization), instead of asserting. Atomic rebuild via `expected/tree.new/` → rename. `git diff fixtures/`. Commit alongside the code change. On a normal run, the same normalizers apply so what's on disk is exactly what the next run will produce.

### Per-scenario normalizers

```ts
type Normalizer = { from: RegExp; to: string };
runScenario({ /* … */ normalize: [{ from: /req-\d+/g, to: 'req-<N>' }] });
```

Applied after the standard normalizers.

### Defaults summary

```js
runScenario({
  fixture,                    // required
  steps,                      // required, array
  mode: 'inproc',             // 'subprocess' for hooks/install (per-subsystem default)
  clock: '2026-01-01T00:00Z', // any frozen ISO date
  seed: 'none',               // or 'scaffold'
  expect: {
    tree: true,               // assert tree (mirror); optionally { ignore: [...] }
    io: false,                // exit code always; opt in for stdout/stderr text
    network: false,           // block-by-default; opt in to assert ledger
  },
  normalize: [],              // additional per-scenario {from, to}
  stubs: { fetch: [], spawn: [] },
});
```

## §3 — Determinism and stubs

Three classes of nondeterminism: **clock**, **randomness/IDs**, and **outbound calls**.

### Clock

**Goal:** `Date.now()`, `new Date()` (no args), `Date.parse(...)` all behave as if it's the scenario's `clock`.

**Primary mechanism (long-term):** `system/scripts/lib/clock.js` exports `now()`, `today()`, `nowIso()`. Source code migrates to it incrementally — opportunistic, not blocking.

**Backstop (sufficient day-one):** monkey-patch `globalThis.Date`:
- `Date.now()` → frozen ms.
- `new Date()` zero args → returns frozen.
- `new Date(arg)` with any args → unchanged (preserves `Date.parse`).

Inproc: scenario-scoped patch. Subprocess: `--import ./tests/lib/preload-clock.mjs`.

### Randomness and IDs

**Goal:** `Math.random()`, `crypto.randomUUID()`, `crypto.randomBytes(n)`, `crypto.getRandomValues(view)` all return deterministic sequences.

**Primary:** `system/scripts/lib/ids.js` — `newId()`, `uuid()`, `randBytes(n)`. Harness sets `ROBIN_RANDOM_SEED=<scenario-name>` (different per scenario surfaces collisions).

**Backstop — full surface:**
- `Math.random` → seeded float in [0, 1).
- `crypto.randomUUID()` → `00000000-0000-4000-8000-<hex-counter>` (RFC v4 shape, deterministic).
- `crypto.randomBytes(n)` → real `Buffer` of length `n` from seeded stream.
- `crypto.getRandomValues(view)` → fills view from seeded stream.

### Outbound network

**Four guarded entry points:** `globalThis.fetch`, `node:http.request`, `node:https.request`, `node:net.connect`.

**Default:** any unmatched call records a `block` event in the ledger and throws `NetworkBlockedError`. **Block enforcement is harness-side, not throw-side** — at scenario end, any `block` events fail the scenario regardless of caller catch behavior.

**Stubs scenario-scoped, passed into `runScenario`:**

```js
await runScenario({
  fixture: '…',
  stubs: {
    fetch: [
      { host: 'api.lunchmoney.app', method: 'GET', path: '/v1/transactions',
        response: { status: 200, body: { transactions: [] } } },
    ],
    spawn: [
      { command: 'claude', response: { exitCode: 0, stdout: '…' } },
    ],
  },
});
```

No global registration. Subprocess passes the registry via `ROBIN_STUBS_FILE=<tempdir>/stubs.json`.

**Matcher precision:**
- `host` — string-exact or `RegExp`.
- `method` — string (case-insensitive, defaults `GET`).
- `path` — matches URL `pathname` only (no query string).
- `query` (optional) — `{ key: value | RegExp }`.

### Outbound subprocesses — same shape

`child_process.spawn`/`spawnSync` treated identically: blocked by default, stubbed via `stubs.spawn`. Matcher: `command` (string-exact or `RegExp`), optional `args` array of `RegExp` (positional, omitted = wildcard). Stub response: `{ exitCode, stdout?, stderr? }`. Recordings merge into the same ledger (kept as `network.json` filename for simplicity), distinguished by an `event` field.

The harness's known-safe spawn list contains only `node` itself.

### Out of scope for stubbing

- **Live Discord gateway** (`discord.js` WebSocket).
- **The real `claude` CLI** — only via stubbed `spawn`.
- **The filesystem** — tempdir provides isolation.

### Step environment

```
ROBIN_WORKSPACE=<tempdir>
ROBIN_CLOCK=2026-05-02T12:00:00Z
ROBIN_RANDOM_SEED=<scenario-name>
ROBIN_STUBS_FILE=<tempdir>/stubs.json
+ scenario-level env overlay
+ step-level env overlay
```

No `ROBIN_E2E` or "are we under test" sentinel — determinism layers do their job without source code branching.

## §4 — Snapshot mechanics

### Capture (at scenario end)

1. **Tree:** walk `<tempdir>/user-data/` recursively. Read each file as UTF-8, apply normalizers, store as `{ relpath → normalizedText }`. **Binary files cause a hard error** with the path — Robin doesn't write binaries today.
2. **IO:** per-step `{ exitCode, stdout, stderr }` normalized.
3. **Outbound ledger:** every fetch/spawn event in call order.

Ignore globs apply at capture, not compare time.

### Comparison (assert mode)

All categories run unconditionally; failures are reported in one summary.

1. **Relpath set diff** — symmetric: missing + unexpected.
2. **Per-file content compare** for relpaths in both sets.
3. **IO/network compare** when opted in.

### Failure output (capped)

```
FAIL system/tests/e2e/memory/recall-multi-entity.test.js
  scenario: memory/recall-multi-entity
  tempdir (preserved): /var/folders/.../robin-e2e-9f8a3b/

  Tree differences (3 files; 2 with content diffs):
    [missing]    user-data/memory/knowledge/topics/work.md
    [unexpected] user-data/memory/streams/inbox.md.bak
    [content]    user-data/memory/INDEX.md
        --- expected
        +++ actual
        @@ -3,2 +3,2 @@
        - streams/inbox.md (lines: <N>)
        + streams/inbox.md (lines: <N>, archived: <N>)

  IO differences:
    step 1: expected exitCode 0, got 2

  Outbound ledger differences: (none)
```

**Caps:** all missing/unexpected relpaths shown (cheap). Content diffs limited to first **5** files; remainder summarized as "and 12 more files differ — see preserved tempdir."

### `UPDATE_SNAPSHOTS=1` (atomic rebuild)

1. Build new contents in `expected/tree.new/`.
2. After full write: `rm -rf expected/tree/` then rename `expected/tree.new/` → `expected/tree/`.
3. `io.snapshot.json` and `network.json` written via temp-file + rename.

Scenario errors (load failure, fixture missing, runtime exception) prevent snapshot write. CI does not set `UPDATE_SNAPSHOTS=1`.

### Authoring workflow

1. Create `system/tests/fixtures/<sub>/<name>/input/user-data/` with seed state. Add `seed: 'scaffold'` to the test file if needed.
2. Write `system/tests/e2e/<sub>/<name>.test.js`.
3. `UPDATE_SNAPSHOTS=1 node --test system/tests/e2e/<sub>/<name>.test.js`.
4. `git diff system/tests/fixtures/<sub>/<name>/expected/` — read every line.
5. Commit code change + fixture input + expected snapshot together.

### Preventing snapshot rot

1. **Dead fixtures** — `system/tests/e2e/lib/fixture-audit.test.js` walks `system/tests/fixtures/` and asserts every leaf scenario dir is referenced by exactly one `.test.js` under `system/tests/e2e/`.
2. **Lazy `UPDATE_SNAPSHOTS=1` updates** — defense is cultural; authoring workflow step 4 frames "read every line" as the gate. PR review sees the snapshot diff.

### What we are not building

- Inline snapshots embedded as strings (mirror tree more reviewable).
- Snapshot versioning across Robin versions.
- Diff viewers richer than the unified-diff above.

## §5 — Subsystem coverage map

Day-one e2e covers what's deterministic. Agent-driven flows (`runtime: agent` jobs like `dream`, `daily-briefing`) are out of scope; their deterministic helpers stay at the unit level and get exercised transitively via the hooks scenarios.

### Day-one inclusion criterion

A scenario lands in day-one if it satisfies at least one of:

1. **Security-critical contract** — wrong behavior is invisible until production and high-cost.
2. **Most refactor-prone surface in its subsystem** — at least one scenario covering the hottest internals.

Day-one is not required to cover every subsystem; agent-driven subsystems get no top-level e2e and that's fine.

### Day-one suite — 9 scenarios across 4 e2e subsystems

#### Hooks (mode: `subprocess`) — 4 scenarios

1. **`hooks/on-pre-tool-use-blocks-pii-write`** — payload writes SSN-shaped string to a memory file; hook exits 2; tree unchanged.
2. **`hooks/on-pre-tool-use-blocks-auto-memory-write`** — payload writes to `~/.claude/projects/<workspace>/memory/foo.md`; hook exits 2.
3. **`hooks/on-pre-bash-blocks-sensitive-command`** — payload `cat ~/.aws/credentials`; hook exits 2; refusal logged.
4. **`hooks/on-stop-comprehensive`** — single on-stop call; asserts auto-memory drained into `inbox.md` with `origin=` tags **and** session-handoff block + last-3 hot.md update produced.

Deferred: `hooks/recall-injection-on-entity-mention`, `hooks/on-session-start-detects-manifest-drift`.

#### Memory operations (mode: `inproc`) — 2 scenarios

1. **`memory/recall-finds-multi-entity-references`** — entity "Alice" mentioned across 3 files; `robin recall Alice --json` returns all 3 hits in stable order.
2. **`memory/index-regen-after-content-change`** — modify a topic file via `writeFile` step; `robin run regenerate-memory-index`; INDEX.md line counts/order updated.

Deferred: `memory/link-inserts-cross-refs`, `memory/lint-detects-orphan-references`, `memory/prune-preserves-recent-content`.

#### Jobs runner (mode: `inproc`) — 2 scenarios

Both use a synthetic fixture job at `<tempdir>/user-data/runtime/jobs/sample.md` with `runtime: node` (not `agent`). Path is in workspace scope; no override needed.

1. **`jobs/run-success-records-success`** — happy path; runtime state updated, `failures.md` unchanged.
2. **`jobs/run-failure-records-failure`** — synthetic failing job; failure recorded with stack/timestamp normalized.

Deferred: `jobs/lock-prevents-concurrent-run`, `jobs/sync-discovers-new-job`.

#### Install (mode: `subprocess`, gated) — 1 scenario

1. **`install/fresh-install-creates-skeleton`** — `npm install <packed-tarball>` into a clean tempdir; postinstall scaffolds `user-data/`, writes manifest, prints `robin init` instructions. Gated behind `test:install` (see §6).

### Subsystems covered transitively or not at all

- **Capture** — agent-driven routing via dream. Deterministic helpers (`handoff.js`, `capture-keyword-scan.js`) covered by units and via `hooks/on-stop-comprehensive`.
- **Dream** — agent-driven. Deterministic prefilter/classify covered by units.
- **Watches**, **Discord bot**, **diagnostics** — out of scope or low refactor pressure.
- **CLI subcommands `init`, `backup`, `restore`, `reset`** — covered transitively (init by install) or by units.

### Implementation phasing — 4 phases

Each phase ends with green CI plus zero flake across 5 sequential local runs.

1. **Harness foundation + 1 smoke scenario.** Build all `lib/` files. Refactor `bin/robin.js` `main()` and `claude-code.js` `runHook`. Ship `hooks/on-pre-bash-blocks-sensitive-command` to validate subprocess mode end-to-end.
2. **Hooks (3 remaining) + memory (2)** — 5 scenarios. Validates both subprocess and inproc paths.
3. **Jobs (2)** — 2 scenarios using `runtime: node` fixture jobs.
4. **Install (1)** — heavyweight, gated.

If a phase reveals a harness-design issue, fix before next phase starts.

### Incremental growth

Adding scenario #20: copy a sibling, swap fixture name, write fixture, `UPDATE_SNAPSHOTS=1`, review, commit. Same cost as scenario #4. Future agent-driven scenarios remain blocked until/unless we invest in stubbing the model — separate decision.

## §6 — CI integration and rollout

The CLI package's existing CI workflow (`.github/workflows/token-budget.yml`) runs `npm test` (= `node --test 'system/tests/**/*.test.js'`). New e2e tests under `system/tests/e2e/**/*.test.js` would be picked up automatically — convenient, but the install scenario must be excluded.

### Test scripts (final state after Phase 4)

```json
"scripts": {
  "test":         "npm run test:unit && npm run test:e2e",
  "test:unit":    "node --test --test-name-pattern='^(?!e2e:)' 'system/tests/**/*.test.js'",
  "test:e2e":     "node --test 'system/tests/e2e/{hooks,memory,jobs}/**/*.test.js'",
  "test:install": "node --test 'system/tests/e2e/install/**/*.test.js'"
}
```

Phase 1 introduces `test:unit` and `test:e2e` only (the e2e glob is valid even when only one scenario exists). Phase 4 adds `test:install` alongside the install scenario.

`describe('e2e: …')` prefixes are how the unit script's `--test-name-pattern` exclusion works. `test:install` is the only path that runs the install scenario.

### CI workflow — new `tests.yml` with three jobs ordered by cost

Lands as a sibling to existing `.github/workflows/token-budget.yml` rather than expanding it; keeps the existing token-budget pipeline focused on its task.

```yaml
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run test:unit

  e2e:
    runs-on: ubuntu-latest
    needs: unit
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run test:e2e
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-tempdirs
          path: /tmp/robin-e2e-*
          if-no-files-found: ignore

  install:
    runs-on: ubuntu-latest
    needs: e2e
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run test:install
```

Unit failure short-circuits e2e and install. Tempdirs from failed e2e runs are uploaded as CI artifacts for raw inspection.

Single OS/Node version on day one (`ubuntu-latest` / Node 22, matching existing `token-budget.yml`).

### Local developer ergonomics

| Command | Runs | Wall-clock | When |
|---|---|---|---|
| `npm run test:unit` | 108 existing units | <5s | Inner loop while editing. |
| `npm run test:e2e` | ~9 inproc + subprocess scenarios | 15–30s | Before pushing a refactor. |
| `npm run test:install` | 1 install scenario | ~10s | Touching `setup.js`, skeleton, install path. |
| `npm test` | All three | ~50s | Equivalent to CI. |

Lefthook pre-push runs `test:unit` only. e2e is too slow for pre-push without becoming friction; CI catches it.

`KEEP_TEMPDIRS=1 npm run test:e2e` retains all tempdirs.

### `UPDATE_SNAPSHOTS=1` does not run in CI

CI does not export `UPDATE_SNAPSHOTS`. The protection is "the workflow doesn't set it" — a contributor editing the workflow to set it would be visible in PR review.

### PR review experience

Snapshot changes appear as file diffs under `system/tests/fixtures/<sub>/<name>/expected/`. Reviewers read them as ordinary GitHub diffs. Because snapshots are normalized text (not JSON-escaped), they render readably. CI doesn't post snapshot diffs as PR comments — GitHub's diff view already shows them.

### Rollout — four PRs

1. **Phase 1 PR.** Keeps `npm test` green. Harness `lib/` files have unit tests of their own (snapshot diff, normalize, clock, ids — 5–10 small units). Smoke scenario runs in the existing `Tests` step.
2. **Phase 2 PR.** Adds `test:e2e` script and the new CI job. Only PR that changes CI structure.
3. **Phase 3 PR.** Adds jobs scenarios. No CI changes.
4. **Phase 4 PR.** Adds `test:install` script + CI job.

Each phase mergeable on its own. Pause-friendly: stopping after Phase 2 leaves a working e2e suite covering hooks + memory.

### Failure-mode budget

- **Subprocess timing.** Postinstall scenarios need ~30s timeout. If install slows, raise once; if it slows again, real signal.
- **Tempdir leakage on CI.** `ubuntu-latest` ephemeral filesystems, no accumulation across runs.

If a flake source produces a recurring failure (≥2 in 7 days), investigate — don't retry-loop. No retry policy in `node:test`; adding one would mask flake.

## Open questions

None blocking implementation. The design is shaped against the codebase as it exists at 2026-05-03; if any of the assumed file paths or runtime behaviors have moved by the time implementation begins, the implementation plan should re-verify before committing to specifics.
