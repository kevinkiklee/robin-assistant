# E2E Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a black-box-ish e2e test harness for the Robin CLI package that locks behavior at well-defined boundaries (filesystem state, exit codes, stub-recorded outbound calls) so internals can be refactored freely.

**Architecture:** Per-test temp `user-data/` seeded from a fixtures directory; deterministic clock/IDs/network stubs; tree-mirror snapshots compared as normalized text. Two run modes (`inproc` for speed, `subprocess` for hooks/install) sharing one API. Implementation in 4 phases, each independently mergeable.

**Tech Stack:** Node 22, `node:test`, ES modules. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-05-03-e2e-test-harness-design.md` — read before starting any task.

---

## File Structure

### New files (Phase 1 — harness foundation)

| Path | Responsibility |
|---|---|
| `system/tests/lib/exit-signal.js` | `ExitSignal` class extending Error, used to convert `process.exit(n)` to throw/catch in inproc mode. |
| `system/tests/lib/clock.js` | `now()`/`today()`/`nowIso()` reading `ROBIN_CLOCK`; `installClock(iso)`/`uninstallClock()` monkey-patches `globalThis.Date`. |
| `system/tests/lib/ids.js` | Seeded `Math.random`/`crypto.randomUUID`/`crypto.randomBytes`/`crypto.getRandomValues`. `installRandom(seed)`/`uninstallRandom()`. |
| `system/tests/lib/normalize.js` | `normalize(text, ctx)` applies the standard normalizer pipeline + per-scenario regex pairs. |
| `system/tests/lib/fixtures.js` | `seedFixture({inputDir, seed, tempdir})` copies skeleton then overlays input. `cleanupTempdir(path, success)`. |
| `system/tests/lib/stubs.js` | `installStubs({fetch, spawn})` patches `fetch`/`http.request`/`https.request`/`net.connect`/`child_process.spawn`. Block-by-default with ledger. |
| `system/tests/lib/snapshot.js` | `captureTree(rootDir, ignoreGlobs)`, `compareTrees(actual, expected)`, `writeTreeAtomic(targetDir, contentMap)`. |
| `system/tests/lib/preload-clock.mjs` | Subprocess preload — installs clock patch from `ROBIN_CLOCK`. |
| `system/tests/lib/preload-random.mjs` | Subprocess preload — installs random patch from `ROBIN_RANDOM_SEED`. |
| `system/tests/lib/preload-stubs.mjs` | Subprocess preload — reads `ROBIN_STUBS_FILE` and installs network/spawn stubs. |
| `system/tests/lib/scenario.js` | `runScenario({fixture, steps, mode, expect, …})` — orchestrates the whole flow. |
| `system/tests/lib/fixture-audit.test.js` | Asserts every fixture dir maps to a `.test.js`. |
| `system/tests/lib/__tests__/clock.test.js` | Unit tests for `clock.js`. |
| `system/tests/lib/__tests__/ids.test.js` | Unit tests for `ids.js`. |
| `system/tests/lib/__tests__/normalize.test.js` | Unit tests for `normalize.js`. |
| `system/tests/lib/__tests__/fixtures.test.js` | Unit tests for `fixtures.js`. |
| `system/tests/lib/__tests__/stubs.test.js` | Unit tests for `stubs.js`. |
| `system/tests/lib/__tests__/snapshot.test.js` | Unit tests for `snapshot.js`. |
| `system/tests/e2e/hooks/on-pre-bash-blocks-sensitive-command.test.js` | Phase 1 smoke scenario. |
| `system/tests/fixtures/hooks/on-pre-bash-blocks-sensitive-command/input/user-data/runtime/state/telemetry/.gitkeep` | Empty seed (telemetry dir exists). |
| `system/tests/fixtures/hooks/on-pre-bash-blocks-sensitive-command/expected/tree/...` | Expected output tree (generated via `UPDATE_SNAPSHOTS=1`). |

### Modified files (Phase 1)

| Path | Change |
|---|---|
| `bin/robin.js` | Extract `main(argv, env): Promise<{exitCode}>`. Convert 8 `process.exit(n)` to `throw new ExitSignal(n)`. Bottom-of-file shell guard handles real subprocess invocation. |
| `system/scripts/hooks/claude-code.js` | Extract `runHook(mode, {stdin, env, workspace}): Promise<{exitCode}>`. Convert 14 `process.exit(n)` to `throw new ExitSignal(n)`. Bottom-of-file shell guard. |
| `package.json` | Add `test:unit` and `test:e2e` scripts; update `test` to chain them. |

### New files (Phase 2)

| Path | Responsibility |
|---|---|
| `system/tests/e2e/hooks/on-pre-tool-use-blocks-pii-write.test.js` + fixture | PII-blocking scenario. |
| `system/tests/e2e/hooks/on-pre-tool-use-blocks-auto-memory-write.test.js` + fixture | Auto-memory-blocking scenario. |
| `system/tests/e2e/hooks/on-stop-comprehensive.test.js` + fixture | Auto-memory drain + handoff scenario. |
| `system/tests/e2e/memory/recall-finds-multi-entity-references.test.js` + fixture | Recall scenario. |
| `system/tests/e2e/memory/index-regen-after-content-change.test.js` + fixture | INDEX regen scenario. |
| `.github/workflows/tests.yml` | New CI workflow (sibling to existing `token-budget.yml`). |

### New files (Phase 3)

| Path | Responsibility |
|---|---|
| `system/tests/e2e/jobs/run-success-records-success.test.js` + fixture | Synthetic `runtime: node` happy-path job. |
| `system/tests/e2e/jobs/run-failure-records-failure.test.js` + fixture | Synthetic failing job. |

### New files (Phase 4)

| Path | Responsibility |
|---|---|
| `system/tests/e2e/install/fresh-install-creates-skeleton.test.js` + fixture | `npm pack` + `npm install` into tempdir. |

### Modified files (Phase 4)

| Path | Change |
|---|---|
| `package.json` | Add `test:install` script. |
| `.github/workflows/tests.yml` | Add `install` job. |

---

# Phase 1 — Harness Foundation + Smoke Scenario

## Task 1: Add `ExitSignal` class

**Files:**
- Create: `system/tests/lib/exit-signal.js`
- Test: covered by usage in `scenario.js` tests later

- [ ] **Step 1: Write the file**

```js
// system/tests/lib/exit-signal.js
export class ExitSignal extends Error {
  constructor(code) {
    super(`ExitSignal(${code})`);
    this.name = 'ExitSignal';
    this.code = Number.isInteger(code) ? code : 1;
  }
}
```

- [ ] **Step 2: Verify it loads**

Run: `node --input-type=module -e "import {ExitSignal} from './system/tests/lib/exit-signal.js'; const e = new ExitSignal(2); console.log(e.code, e instanceof Error);"`
Expected: `2 true`

- [ ] **Step 3: Commit**

```bash
git add system/tests/lib/exit-signal.js
git commit -m "feat(tests): add ExitSignal class for inproc exit-code propagation"
```

---

## Task 2: Implement `clock.js` (with monkey-patch installer)

**Files:**
- Create: `system/tests/lib/clock.js`
- Test: `system/tests/lib/__tests__/clock.test.js`

- [ ] **Step 1: Write failing test**

```js
// system/tests/lib/__tests__/clock.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { now, today, nowIso, installClock, uninstallClock } from '../clock.js';

describe('clock', () => {
  afterEach(() => { uninstallClock(); delete process.env.ROBIN_CLOCK; });

  it('now() returns real time when ROBIN_CLOCK unset', () => {
    const t = now();
    assert.ok(Math.abs(t - Date.now()) < 100);
  });

  it('now() returns frozen time when ROBIN_CLOCK set', () => {
    process.env.ROBIN_CLOCK = '2026-05-02T12:00:00Z';
    assert.equal(now(), Date.parse('2026-05-02T12:00:00Z'));
  });

  it('today() formats YYYY-MM-DD from frozen clock', () => {
    process.env.ROBIN_CLOCK = '2026-05-02T12:00:00Z';
    assert.equal(today(), '2026-05-02');
  });

  it('nowIso() returns ISO from frozen clock', () => {
    process.env.ROBIN_CLOCK = '2026-05-02T12:00:00Z';
    assert.equal(nowIso(), '2026-05-02T12:00:00.000Z');
  });

  it('installClock patches Date.now and zero-arg new Date()', () => {
    installClock('2026-05-02T12:00:00Z');
    assert.equal(Date.now(), Date.parse('2026-05-02T12:00:00Z'));
    assert.equal(new Date().toISOString(), '2026-05-02T12:00:00.000Z');
  });

  it('installClock leaves new Date(arg) alone', () => {
    installClock('2026-05-02T12:00:00Z');
    assert.equal(new Date('2020-01-01T00:00:00Z').toISOString(), '2020-01-01T00:00:00.000Z');
    assert.equal(Date.parse('2020-01-01T00:00:00Z'), 1577836800000);
  });

  it('uninstallClock restores real Date.now', () => {
    installClock('2026-05-02T12:00:00Z');
    uninstallClock();
    assert.ok(Math.abs(Date.now() - new Date().getTime()) < 100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test system/tests/lib/__tests__/clock.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `clock.js`**

```js
// system/tests/lib/clock.js
const realDate = globalThis.Date;
let installed = null;

export function now() {
  const env = process.env.ROBIN_CLOCK;
  return env ? realDate.parse(env) : realDate.now();
}

export function today() {
  return new realDate(now()).toISOString().slice(0, 10);
}

export function nowIso() {
  return new realDate(now()).toISOString();
}

export function installClock(iso) {
  if (installed) uninstallClock();
  const frozenMs = realDate.parse(iso);
  if (Number.isNaN(frozenMs)) throw new Error(`installClock: invalid ISO ${iso}`);

  // eslint-disable-next-line no-global-assign
  globalThis.Date = class extends realDate {
    constructor(...args) {
      if (args.length === 0) super(frozenMs);
      else super(...args);
    }
    static now() { return frozenMs; }
    static parse = realDate.parse;
    static UTC = realDate.UTC;
  };
  installed = true;
  process.env.ROBIN_CLOCK = iso;
}

export function uninstallClock() {
  if (!installed) return;
  // eslint-disable-next-line no-global-assign
  globalThis.Date = realDate;
  installed = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test system/tests/lib/__tests__/clock.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add system/tests/lib/clock.js system/tests/lib/__tests__/clock.test.js
git commit -m "feat(tests): add deterministic clock for e2e harness"
```

---

## Task 3: Implement `ids.js` (seeded random + UUID + bytes)

**Files:**
- Create: `system/tests/lib/ids.js`
- Test: `system/tests/lib/__tests__/ids.test.js`

- [ ] **Step 1: Write failing test**

```js
// system/tests/lib/__tests__/ids.test.js
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installRandom, uninstallRandom } from '../ids.js';

describe('ids', () => {
  afterEach(() => uninstallRandom());

  it('Math.random produces deterministic sequence with same seed', () => {
    installRandom('seed-A');
    const a = [Math.random(), Math.random(), Math.random()];
    uninstallRandom();
    installRandom('seed-A');
    const b = [Math.random(), Math.random(), Math.random()];
    assert.deepEqual(a, b);
  });

  it('different seeds produce different sequences', () => {
    installRandom('seed-A');
    const a = Math.random();
    uninstallRandom();
    installRandom('seed-B');
    const b = Math.random();
    assert.notEqual(a, b);
  });

  it('crypto.randomUUID returns RFC v4-shaped string', () => {
    installRandom('seed-A');
    const id = crypto.randomUUID();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('crypto.randomUUID is deterministic', () => {
    installRandom('seed-A');
    const a = crypto.randomUUID();
    uninstallRandom();
    installRandom('seed-A');
    const b = crypto.randomUUID();
    assert.equal(a, b);
  });

  it('crypto.randomBytes returns Buffer of correct length', async () => {
    installRandom('seed-A');
    const { randomBytes } = await import('node:crypto');
    const buf = randomBytes(16);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.length, 16);
  });

  it('uninstallRandom restores Math.random', () => {
    installRandom('seed-A');
    uninstallRandom();
    const a = Math.random();
    const b = Math.random();
    // Real Math.random — virtually never equal.
    assert.notEqual(a, b);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test system/tests/lib/__tests__/ids.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ids.js`**

```js
// system/tests/lib/ids.js
import * as nodeCrypto from 'node:crypto';

const realMathRandom = Math.random.bind(Math);
const realRandomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
const realGetRandomValues = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
const realRandomBytes = nodeCrypto.randomBytes.bind(nodeCrypto);

let state = null; // { seed, counter, mulberry32 }

function hashSeed(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seedInt) {
  let s = seedInt >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nextByte() {
  return Math.floor(state.rand() * 256);
}

export function installRandom(seed) {
  if (state) uninstallRandom();
  state = { seed, counter: 0, rand: mulberry32(hashSeed(seed)) };

  Math.random = state.rand;

  globalThis.crypto.randomUUID = function () {
    const bytes = Array.from({ length: 16 }, () => nextByte().toString(16).padStart(2, '0'));
    bytes[6] = '4' + bytes[6][1];
    bytes[8] = (['8', '9', 'a', 'b'][nextByte() % 4]) + bytes[8][1];
    return `${bytes.slice(0, 4).join('')}-${bytes.slice(4, 6).join('')}-${bytes.slice(6, 8).join('')}-${bytes.slice(8, 10).join('')}-${bytes.slice(10, 16).join('')}`;
  };

  globalThis.crypto.getRandomValues = function (view) {
    for (let i = 0; i < view.length; i++) view[i] = nextByte();
    return view;
  };

  // node:crypto module — patch on the imported namespace.
  nodeCrypto.randomBytes = function (n) {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = nextByte();
    return buf;
  };

  process.env.ROBIN_RANDOM_SEED = seed;
}

export function uninstallRandom() {
  if (!state) return;
  Math.random = realMathRandom;
  if (realRandomUUID) globalThis.crypto.randomUUID = realRandomUUID;
  if (realGetRandomValues) globalThis.crypto.getRandomValues = realGetRandomValues;
  nodeCrypto.randomBytes = realRandomBytes;
  state = null;
  delete process.env.ROBIN_RANDOM_SEED;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `node --test system/tests/lib/__tests__/ids.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add system/tests/lib/ids.js system/tests/lib/__tests__/ids.test.js
git commit -m "feat(tests): add deterministic random/UUID/bytes for e2e harness"
```

---

## Task 4: Implement `normalize.js`

**Files:**
- Create: `system/tests/lib/normalize.js`
- Test: `system/tests/lib/__tests__/normalize.test.js`

- [ ] **Step 1: Write failing test**

```js
// system/tests/lib/__tests__/normalize.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../normalize.js';

const baseCtx = { workspace: '/tmp/robin-e2e-abc', clockMs: Date.parse('2026-05-02T12:00:00Z'), extra: [] };

describe('normalize', () => {
  it('strips ANSI escapes', () => {
    assert.equal(normalize('\x1B[31mred\x1B[0m', baseCtx), 'red');
  });

  it('LF-normalizes line endings', () => {
    assert.equal(normalize('a\r\nb\rc', baseCtx), 'a\nb\nc');
  });

  it('replaces workspace prefix with <WS>', () => {
    assert.equal(normalize('path: /tmp/robin-e2e-abc/foo.md', baseCtx), 'path: <WS>/foo.md');
  });

  it('collapses ISO timestamps within ±1 day of clock', () => {
    const out = normalize('time: 2026-05-02T13:00:00.000Z', baseCtx);
    assert.equal(out, 'time: <TS>');
  });

  it('leaves ISO timestamps outside ±1 day window unchanged', () => {
    const out = normalize('time: 2020-01-01T00:00:00.000Z', baseCtx);
    assert.equal(out, 'time: 2020-01-01T00:00:00.000Z');
  });

  it('applies per-scenario normalizers last', () => {
    const ctx = { ...baseCtx, extra: [{ from: /req-\d+/g, to: 'req-<N>' }] };
    assert.equal(normalize('id: req-42', ctx), 'id: req-<N>');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test system/tests/lib/__tests__/normalize.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `normalize.js`**

```js
// system/tests/lib/normalize.js
const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;
const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function normalize(text, ctx) {
  let out = String(text);
  // 1. Strip ANSI
  out = out.replace(ANSI, '');
  // 2. LF-normalize
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 3. Workspace prefix → <WS>
  if (ctx.workspace) {
    // Longest-match-first: try with trailing slash first, then without.
    const ws = ctx.workspace;
    out = out.split(ws + '/').join('<WS>/').split(ws).join('<WS>');
  }
  // 4. ISO timestamps within ±1 day of frozen clock → <TS>
  if (ctx.clockMs) {
    out = out.replace(ISO_TS, (m) => {
      const t = Date.parse(m);
      if (Number.isNaN(t)) return m;
      return Math.abs(t - ctx.clockMs) <= ONE_DAY_MS ? '<TS>' : m;
    });
  }
  // 5. Per-scenario normalizers
  for (const { from, to } of ctx.extra ?? []) {
    out = out.replace(from, to);
  }
  return out;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `node --test system/tests/lib/__tests__/normalize.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add system/tests/lib/normalize.js system/tests/lib/__tests__/normalize.test.js
git commit -m "feat(tests): add normalize pipeline for snapshot stability"
```

---

## Task 5: Implement `fixtures.js`

**Files:**
- Create: `system/tests/lib/fixtures.js`
- Test: `system/tests/lib/__tests__/fixtures.test.js`

- [ ] **Step 1: Write failing test**

```js
// system/tests/lib/__tests__/fixtures.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { seedFixture, makeTempdir, cleanupTempdir } from '../fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

describe('fixtures', () => {
  let tmp;
  beforeEach(() => { tmp = makeTempdir(); });
  afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  it('makeTempdir creates robin-e2e-<uuid> dir under os.tmpdir()', () => {
    assert.ok(existsSync(tmp));
    assert.match(tmp, /robin-e2e-/);
    assert.ok(tmp.startsWith(tmpdir()));
  });

  it('seedFixture with seed=none copies only input/', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'fixt-'));
    mkdirSync(join(fixtureDir, 'input/user-data/memory'), { recursive: true });
    writeFileSync(join(fixtureDir, 'input/user-data/memory/INDEX.md'), 'hello');

    seedFixture({ fixtureDir, seed: 'none', tempdir: tmp });
    assert.equal(readFileSync(join(tmp, 'user-data/memory/INDEX.md'), 'utf8'), 'hello');
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('seedFixture with seed=skeleton copies skeleton then overlays input/', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'fixt-'));
    mkdirSync(join(fixtureDir, 'input/user-data/memory'), { recursive: true });
    writeFileSync(join(fixtureDir, 'input/user-data/memory/INDEX.md'), 'OVERRIDE');

    seedFixture({ fixtureDir, seed: 'scaffold', tempdir: tmp, repoRoot: REPO_ROOT });
    // Skeleton-derived file exists.
    assert.ok(existsSync(join(tmp, 'user-data/memory')), 'skeleton memory dir should exist');
    // Override won.
    assert.equal(readFileSync(join(tmp, 'user-data/memory/INDEX.md'), 'utf8'), 'OVERRIDE');
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('cleanupTempdir(success=true) deletes the dir', () => {
    cleanupTempdir(tmp, true);
    assert.equal(existsSync(tmp), false);
    tmp = null;
  });

  it('cleanupTempdir(success=false) preserves the dir', () => {
    cleanupTempdir(tmp, false);
    assert.ok(existsSync(tmp));
  });

  it('cleanupTempdir respects KEEP_TEMPDIRS=1', () => {
    process.env.KEEP_TEMPDIRS = '1';
    try {
      cleanupTempdir(tmp, true);
      assert.ok(existsSync(tmp));
    } finally {
      delete process.env.KEEP_TEMPDIRS;
    }
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test system/tests/lib/__tests__/fixtures.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `fixtures.js`**

```js
// system/tests/lib/fixtures.js
import { mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function makeTempdir() {
  const dir = join(tmpdir(), `robin-e2e-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {{
 *   fixtureDir: string,    // absolute path to system/tests/fixtures/<sub>/<name>/
 *   seed: 'none' | 'scaffold',
 *   tempdir: string,       // destination
 *   repoRoot?: string,     // package root, needed for seed='scaffold'
 * }} opts
 */
export function seedFixture({ fixtureDir, seed, tempdir, repoRoot }) {
  if (seed === 'scaffold') {
    if (!repoRoot) throw new Error('seed=skeleton requires repoRoot');
    const skeleton = join(repoRoot, 'system/scaffold');
    if (!existsSync(skeleton)) {
      throw new Error(`skeleton not found at ${skeleton}`);
    }
    cpSync(skeleton, join(tempdir, 'user-data'), { recursive: true, errorOnExist: false });
  }
  const inputDir = join(fixtureDir, 'input');
  if (existsSync(inputDir)) {
    cpSync(inputDir, tempdir, { recursive: true, force: true });
  }
}

export function cleanupTempdir(path, success) {
  if (process.env.KEEP_TEMPDIRS === '1') {
    process.stderr.write(`KEEP_TEMPDIRS: ${path}\n`);
    return;
  }
  if (success) {
    rmSync(path, { recursive: true, force: true });
  } else {
    process.stderr.write(`tempdir preserved (failure): ${path}\n`);
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `node --test system/tests/lib/__tests__/fixtures.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add system/tests/lib/fixtures.js system/tests/lib/__tests__/fixtures.test.js
git commit -m "feat(tests): add fixture seeding + tempdir lifecycle"
```

---

## Task 6: Implement `stubs.js`

**Files:**
- Create: `system/tests/lib/stubs.js`
- Test: `system/tests/lib/__tests__/stubs.test.js`

This is the largest harness module. The implementation patches `globalThis.fetch` and `child_process.spawn`/`spawnSync`. We deliberately do *not* patch `node:http.request`/`node:https.request`/`node:net.connect` directly in v1 — `globalThis.fetch` covers Robin's HTTP surface, and a more thorough net layer can be added later if needed. The block-by-default still applies via `globalThis.fetch`. (This narrows scope vs. the spec; document the scope cut in a code comment.)

- [ ] **Step 1: Write failing test**

```js
// system/tests/lib/__tests__/stubs.test.js
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { installStubs, uninstallStubs, getLedger, hasBlockEvents } from '../stubs.js';

describe('stubs', () => {
  afterEach(() => uninstallStubs());

  it('blocked fetch records block event and throws', async () => {
    installStubs({ fetch: [], spawn: [] });
    await assert.rejects(() => fetch('https://example.com/foo'), /NetworkBlocked/);
    const ledger = getLedger();
    assert.equal(ledger[0].event, 'block');
    assert.equal(ledger[0].host, 'example.com');
    assert.equal(ledger[0].path, '/foo');
    assert.equal(hasBlockEvents(), true);
  });

  it('matched fetch returns stub response and records call', async () => {
    installStubs({
      fetch: [{ host: 'api.example.com', method: 'GET', path: '/v1/items', response: { status: 200, body: { items: [1, 2] } } }],
      spawn: [],
    });
    const res = await fetch('https://api.example.com/v1/items');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { items: [1, 2] });
    assert.equal(getLedger()[0].event, 'call');
    assert.equal(hasBlockEvents(), false);
  });

  it('fetch matcher requires method match', async () => {
    installStubs({
      fetch: [{ host: 'api.example.com', method: 'POST', path: '/v1/items', response: { status: 201 } }],
      spawn: [],
    });
    // GET should miss, fall through to block.
    await assert.rejects(() => fetch('https://api.example.com/v1/items'), /NetworkBlocked/);
  });

  it('blocked spawn records block event and throws', () => {
    installStubs({ fetch: [], spawn: [] });
    assert.throws(() => spawnSync('claude', ['--help']), /SpawnBlocked/);
    assert.equal(getLedger()[0].event, 'block');
    assert.equal(getLedger()[0].command, 'claude');
  });

  it('node spawn is allowed by default (known-safe)', () => {
    installStubs({ fetch: [], spawn: [] });
    const r = spawnSync('node', ['-e', 'process.exit(0)']);
    assert.equal(r.status, 0);
  });

  it('matched spawn returns stub stdout/exitCode', () => {
    installStubs({
      fetch: [],
      spawn: [{ command: 'claude', response: { exitCode: 0, stdout: 'hello\n' } }],
    });
    const r = spawnSync('claude', ['--help']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.toString(), 'hello\n');
  });

  it('uninstallStubs restores fetch and spawnSync', async () => {
    installStubs({ fetch: [], spawn: [] });
    uninstallStubs();
    // Real fetch/spawn — don't actually call out, just check binding.
    assert.equal(typeof fetch, 'function');
    assert.equal(typeof spawnSync, 'function');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test system/tests/lib/__tests__/stubs.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `stubs.js`**

```js
// system/tests/lib/stubs.js
//
// Outbound call stubs for the e2e harness.
//
// Surface covered in v1: globalThis.fetch + node:child_process spawn/spawnSync.
// Not covered in v1: direct node:http.request / https.request / net.connect.
// Robin's outbound calls all go through fetch today; if a future Robin path
// uses raw http/net, extend this module.
//
// Block-by-default: any unmatched call records a `block` event and throws.

import * as childProcess from 'node:child_process';

const realFetch = globalThis.fetch;
const realSpawn = childProcess.spawn;
const realSpawnSync = childProcess.spawnSync;

const KNOWN_SAFE_COMMANDS = new Set(['node']);

let state = null; // { spec, ledger }

function matches(matcher, value) {
  if (matcher instanceof RegExp) return matcher.test(value);
  return matcher === value;
}

function matchFetch(stub, { method, host, path }) {
  if (!matches(stub.host, host)) return false;
  const stubMethod = (stub.method ?? 'GET').toUpperCase();
  if (stubMethod !== method.toUpperCase()) return false;
  if (!matches(stub.path, path)) return false;
  return true;
}

function matchSpawn(stub, command, args) {
  if (!matches(stub.command, command)) return false;
  if (stub.args) {
    for (let i = 0; i < stub.args.length; i++) {
      if (!matches(stub.args[i], args[i] ?? '')) return false;
    }
  }
  return true;
}

class NetworkBlockedError extends Error {
  constructor(host, path) { super(`NetworkBlocked: ${host}${path}`); }
}
class SpawnBlockedError extends Error {
  constructor(command) { super(`SpawnBlocked: ${command}`); }
}

export function installStubs(spec) {
  if (state) uninstallStubs();
  state = { spec, ledger: [] };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const meta = { method, host: url.host, path: url.pathname, query: url.search };

    for (const stub of spec.fetch ?? []) {
      if (matchFetch(stub, meta)) {
        state.ledger.push({ event: 'call', ...meta });
        const r = stub.response ?? { status: 200 };
        const body = r.body !== undefined
          ? (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
          : '';
        return new Response(body, {
          status: r.status ?? 200,
          headers: r.headers ?? { 'content-type': 'application/json' },
        });
      }
    }
    state.ledger.push({ event: 'block', ...meta });
    throw new NetworkBlockedError(url.host, url.pathname);
  };

  childProcess.spawn = function (command, args = [], options) {
    if (KNOWN_SAFE_COMMANDS.has(command)) return realSpawn(command, args, options);
    for (const stub of spec.spawn ?? []) {
      if (matchSpawn(stub, command, args)) {
        state.ledger.push({ event: 'call', command, args });
        // Stubbed spawn — not implemented for streaming; tests use spawnSync.
        // Throwing here surfaces accidental spawn() use.
        throw new Error('stubbed child_process.spawn() is not implemented; use spawnSync in code or expand stubs');
      }
    }
    state.ledger.push({ event: 'block', command, args });
    throw new SpawnBlockedError(command);
  };

  childProcess.spawnSync = function (command, args = [], options) {
    if (KNOWN_SAFE_COMMANDS.has(command)) return realSpawnSync(command, args, options);
    for (const stub of spec.spawn ?? []) {
      if (matchSpawn(stub, command, args)) {
        state.ledger.push({ event: 'call', command, args });
        const r = stub.response ?? { exitCode: 0 };
        return {
          pid: -1,
          status: r.exitCode ?? 0,
          stdout: Buffer.from(r.stdout ?? ''),
          stderr: Buffer.from(r.stderr ?? ''),
          signal: null,
          output: [null, Buffer.from(r.stdout ?? ''), Buffer.from(r.stderr ?? '')],
        };
      }
    }
    state.ledger.push({ event: 'block', command, args });
    throw new SpawnBlockedError(command);
  };
}

export function uninstallStubs() {
  if (!state) return;
  globalThis.fetch = realFetch;
  childProcess.spawn = realSpawn;
  childProcess.spawnSync = realSpawnSync;
  state = null;
}

export function getLedger() {
  return state ? [...state.ledger] : [];
}

export function hasBlockEvents() {
  return state ? state.ledger.some((e) => e.event === 'block') : false;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `node --test system/tests/lib/__tests__/stubs.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add system/tests/lib/stubs.js system/tests/lib/__tests__/stubs.test.js
git commit -m "feat(tests): add fetch/spawn stubs with block-by-default ledger"
```

---

## Task 7: Implement `snapshot.js`

**Files:**
- Create: `system/tests/lib/snapshot.js`
- Test: `system/tests/lib/__tests__/snapshot.test.js`

- [ ] **Step 1: Write failing test**

```js
// system/tests/lib/__tests__/snapshot.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { captureTree, compareTrees, writeTreeAtomic } from '../snapshot.js';

describe('snapshot', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'snap-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('captureTree returns map of relpath → text', () => {
    mkdirSync(join(root, 'a/b'), { recursive: true });
    writeFileSync(join(root, 'a/b/c.md'), 'hello');
    writeFileSync(join(root, 'top.md'), 'world');
    const tree = captureTree(root, []);
    assert.deepEqual(tree, { 'a/b/c.md': 'hello', 'top.md': 'world' });
  });

  it('captureTree skips ignored globs', () => {
    mkdirSync(join(root, 'logs'), { recursive: true });
    writeFileSync(join(root, 'logs/perf.log'), 'ignored');
    writeFileSync(join(root, 'kept.md'), 'kept');
    const tree = captureTree(root, ['logs/**']);
    assert.deepEqual(tree, { 'kept.md': 'kept' });
  });

  it('captureTree throws on binary file', () => {
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0x00, 0xff, 0x00, 0xff]));
    assert.throws(() => captureTree(root, []), /binary/i);
  });

  it('compareTrees returns missing/unexpected/content lists', () => {
    const expected = { 'a.md': 'A', 'b.md': 'B' };
    const actual = { 'a.md': 'A', 'c.md': 'C' }; // missing b, unexpected c
    const diff = compareTrees(actual, expected);
    assert.deepEqual(diff.missing, ['b.md']);
    assert.deepEqual(diff.unexpected, ['c.md']);
    assert.deepEqual(diff.contentDiffs, []);
  });

  it('compareTrees flags content diffs', () => {
    const diff = compareTrees({ 'a.md': 'A1' }, { 'a.md': 'A2' });
    assert.equal(diff.contentDiffs.length, 1);
    assert.equal(diff.contentDiffs[0].relpath, 'a.md');
  });

  it('writeTreeAtomic rebuilds target dir', () => {
    const target = join(root, 'expected/tree');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'old.md'), 'will be deleted');
    writeTreeAtomic(target, { 'a.md': 'A', 'sub/b.md': 'B' });
    assert.equal(existsSync(join(target, 'old.md')), false);
    assert.equal(readFileSync(join(target, 'a.md'), 'utf8'), 'A');
    assert.equal(readFileSync(join(target, 'sub/b.md'), 'utf8'), 'B');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test system/tests/lib/__tests__/snapshot.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `snapshot.js`**

```js
// system/tests/lib/snapshot.js
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';

function* walk(rootDir, currentDir) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const full = join(currentDir, entry.name);
    if (entry.isDirectory()) yield* walk(rootDir, full);
    else if (entry.isFile()) yield relative(rootDir, full).split(sep).join('/');
  }
}

function matchesAnyGlob(relpath, globs) {
  for (const g of globs) {
    // Minimal glob: convert ** and * to regex parts.
    const re = new RegExp('^' + g
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.+')
      .replace(/\*/g, '[^/]+')
      + '$');
    if (re.test(relpath)) return true;
  }
  return false;
}

function looksBinary(buf) {
  // First 8KB; nul byte → binary.
  const slice = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < slice.length; i++) if (slice[i] === 0) return true;
  return false;
}

export function captureTree(rootDir, ignoreGlobs = []) {
  if (!existsSync(rootDir)) return {};
  const out = {};
  for (const rel of walk(rootDir, rootDir)) {
    if (matchesAnyGlob(rel, ignoreGlobs)) continue;
    const buf = readFileSync(join(rootDir, rel));
    if (looksBinary(buf)) {
      throw new Error(`captureTree: binary file at ${rel} — Robin shouldn't write binaries; expand harness if intentional`);
    }
    out[rel] = buf.toString('utf8');
  }
  return out;
}

export function compareTrees(actualMap, expectedMap) {
  const actualKeys = new Set(Object.keys(actualMap));
  const expectedKeys = new Set(Object.keys(expectedMap));
  const missing = [...expectedKeys].filter((k) => !actualKeys.has(k)).sort();
  const unexpected = [...actualKeys].filter((k) => !expectedKeys.has(k)).sort();
  const contentDiffs = [];
  for (const k of [...expectedKeys].sort()) {
    if (actualKeys.has(k) && actualMap[k] !== expectedMap[k]) {
      contentDiffs.push({ relpath: k, expected: expectedMap[k], actual: actualMap[k] });
    }
  }
  return { missing, unexpected, contentDiffs };
}

export function writeTreeAtomic(targetDir, contentMap) {
  const tmp = targetDir + '.new';
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const [rel, content] of Object.entries(contentMap)) {
    const full = join(tmp, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  renameSync(tmp, targetDir);
}

export function loadExpectedTree(expectedDir) {
  if (!existsSync(expectedDir)) return {};
  const out = {};
  for (const rel of walk(expectedDir, expectedDir)) {
    out[rel] = readFileSync(join(expectedDir, rel), 'utf8');
  }
  return out;
}

export function formatDiff({ missing, unexpected, contentDiffs }, { contentDiffCap = 5 } = {}) {
  const lines = [];
  const total = missing.length + unexpected.length + contentDiffs.length;
  lines.push(`  Tree differences (${total} files; ${contentDiffs.length} with content diffs):`);
  for (const m of missing) lines.push(`    [missing]    ${m}`);
  for (const u of unexpected) lines.push(`    [unexpected] ${u}`);
  for (const c of contentDiffs.slice(0, contentDiffCap)) {
    lines.push(`    [content]    ${c.relpath}`);
    lines.push('        --- expected');
    lines.push('        +++ actual');
    const exp = c.expected.split('\n');
    const act = c.actual.split('\n');
    for (const l of exp) lines.push(`        - ${l}`);
    for (const l of act) lines.push(`        + ${l}`);
  }
  if (contentDiffs.length > contentDiffCap) {
    lines.push(`    … and ${contentDiffs.length - contentDiffCap} more files differ — see preserved tempdir.`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `node --test system/tests/lib/__tests__/snapshot.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add system/tests/lib/snapshot.js system/tests/lib/__tests__/snapshot.test.js
git commit -m "feat(tests): add tree capture/compare/writeAtomic snapshot lib"
```

---

## Task 8: Add subprocess preload modules

**Files:**
- Create: `system/tests/lib/preload-clock.mjs`
- Create: `system/tests/lib/preload-random.mjs`
- Create: `system/tests/lib/preload-stubs.mjs`

These are minimal — they import the corresponding lib and call the installer based on env vars. No tests of their own; they're exercised end-to-end via subprocess scenarios.

- [ ] **Step 1: Write the three preload files**

```js
// system/tests/lib/preload-clock.mjs
import { installClock } from './clock.js';
if (process.env.ROBIN_CLOCK) installClock(process.env.ROBIN_CLOCK);
```

```js
// system/tests/lib/preload-random.mjs
import { installRandom } from './ids.js';
if (process.env.ROBIN_RANDOM_SEED) installRandom(process.env.ROBIN_RANDOM_SEED);
```

```js
// system/tests/lib/preload-stubs.mjs
import { readFileSync, existsSync } from 'node:fs';
import { installStubs } from './stubs.js';
if (process.env.ROBIN_STUBS_FILE && existsSync(process.env.ROBIN_STUBS_FILE)) {
  const spec = JSON.parse(readFileSync(process.env.ROBIN_STUBS_FILE, 'utf8'));
  // RegExp matchers need rehydration when shipped via JSON — phase 1 supports
  // string-only matchers in subprocess scenarios. RegExp matchers work in inproc
  // mode. Subprocess RegExp support is a phase-2+ enhancement if needed.
  installStubs(spec);
}
```

- [ ] **Step 2: Verify the modules load**

Run: `node --import ./system/tests/lib/preload-clock.mjs --import ./system/tests/lib/preload-random.mjs --import ./system/tests/lib/preload-stubs.mjs -e "console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add system/tests/lib/preload-clock.mjs system/tests/lib/preload-random.mjs system/tests/lib/preload-stubs.mjs
git commit -m "feat(tests): add subprocess preloads for clock/random/stubs"
```

---

## Task 9: Refactor `bin/robin.js` to extract `main(argv, env)`

**Files:**
- Modify: `bin/robin.js` (lines 37–110, all 8 `process.exit` sites + bottom shell)

The existing structure has `main()` reading `process.argv`/`process.env` directly and using `process.exit` in 8 places. After this refactor:

1. `main(argv, env): Promise<{exitCode}>` accepts both as parameters and returns the exit code.
2. Inside `main`, every `process.exit(n)` becomes `throw new ExitSignal(n)`.
3. The bottom-of-file shell guard is portable across symlinks and only fires for true subprocess invocation.

- [ ] **Step 1: Apply the refactor**

Replace the contents of `bin/robin.js` from line 37 to end of file with:

```js
async function main(argv = process.argv.slice(2), env = process.env) {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(HELP);
    return { exitCode: 0 };
  }

  if (cmd === 'init') {
    const { cmdInit } = await import('../system/scripts/cli/init.js');
    await cmdInit(rest);
    return { exitCode: 0 };
  }
  if (cmd === 'run') {
    const cli = await import('../system/scripts/cli/jobs.js');
    await cli.cmdRun(rest);
    return { exitCode: 0 };
  }
  if (cmd === 'job') {
    const cli = await import('../system/scripts/cli/jobs.js');
    await cli.cmdJob(rest);
    return { exitCode: 0 };
  }
  if (cmd === 'jobs') {
    const cli = await import('../system/scripts/cli/jobs.js');
    await cli.dispatchJobs(rest);
    return { exitCode: 0 };
  }
  if (cmd === 'update') {
    const { runPreflight } = await import('../system/scripts/lib/preflight.js');
    const r = await runPreflight();
    for (const f of r.findings) console.log(`${f.level}: ${f.message}`);
    if (r.findings.some((f) => f.level === 'FATAL')) return { exitCode: 1 };
    if (r.findings.length === 0) console.log('Nothing to do.');
    return { exitCode: 0 };
  }
  if (cmd === 'link') {
    const { cmdLink } = await import('../system/scripts/wiki-graph/lib/cli-link.js');
    return { exitCode: await cmdLink(rest) };
  }
  if (cmd === 'watch') {
    const { dispatchWatch } = await import('../system/scripts/cli/watches.js');
    await dispatchWatch(rest);
    return { exitCode: 0 };
  }

  if (cmd === 'recall') {
    if (rest.length === 0) {
      process.stderr.write('Usage: robin recall [--json] <term> [<term> ...]\n');
      return { exitCode: 1 };
    }
    const wantsJson = rest[0] === '--json' && rest.shift();
    if (rest.length === 0) {
      process.stderr.write('Usage: robin recall [--json] <term> [<term> ...]\n');
      return { exitCode: 1 };
    }
    const { recall, formatRecallHits } = await import('../system/scripts/memory/lib/recall.js');
    const { resolveCliWorkspaceDir } = await import('../system/scripts/lib/workspace-root.js');
    const ws = resolveCliWorkspaceDir();
    const result = recall(ws, rest);
    if (wantsJson) {
      console.log(JSON.stringify(result));
    } else {
      const formatted = formatRecallHits(result);
      console.log(formatted || 'No matches.');
    }
    return { exitCode: 0 };
  }

  process.stderr.write(`unknown command: ${cmd}\n${HELP}`);
  return { exitCode: 2 };
}

export { main };

// Subprocess shell guard — runs only when invoked directly, not when imported.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const isMain = process.argv[1]
  && (() => {
    try {
      return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
      return false;
    }
  })();

if (isMain) {
  main()
    .then(({ exitCode }) => process.exit(exitCode))
    .catch((err) => {
      process.stderr.write(`robin: ${err.stack || err.message}\n`);
      process.exit(1);
    });
}
```

- [ ] **Step 2: Run existing tests to confirm no regression**

Run: `npm run test:unit` (or, before scripts split: `npm test`)
Expected: all 108 existing units pass.

- [ ] **Step 3: Smoke-test the binary manually**

Run: `node bin/robin.js --help`
Expected: prints HELP, exits 0.

Run: `node bin/robin.js bogus-command; echo "exit=$?"`
Expected: prints unknown command + HELP to stderr, `exit=2`.

- [ ] **Step 4: Commit**

```bash
git add bin/robin.js
git commit -m "refactor(bin): extract main(argv, env) returning {exitCode}

Prepares for in-process invocation by the e2e harness. The bottom shell
guard preserves subprocess behavior; main() no longer calls process.exit
directly."
```

---

## Task 10: Refactor `system/scripts/hooks/claude-code.js` to extract `runHook`

**Files:**
- Modify: `system/scripts/hooks/claude-code.js` (top-level body and 14 `process.exit` sites)

The strategy: wrap the existing top-level body in a `runHook(mode, opts)` async function that returns `{ exitCode }`. Convert each `process.exit(n)` to `return { exitCode: n }` (when in the top level) or `throw new ExitSignal(n)` (when in nested helpers called from the top level).

Concretely: the existing file has parsing logic at top, then mode-dispatch with `process.exit` calls. We hoist all that into a function.

- [ ] **Step 1: Inspect current structure**

Run: `grep -n 'process\.exit\|^function\|^async function' system/scripts/hooks/claude-code.js | head -40`

Identify the existing entry point (where `parseArgs` is called and mode dispatch begins). Note the 14 exit sites — most are inside the top-level body or short helpers.

- [ ] **Step 2: Apply the refactor**

The exact edit depends on where the existing top-level body sits (around lines 250–600 based on the line numbers from the grep). Wrap the body in:

```js
import { ExitSignal } from '../../tests/lib/exit-signal.js';

export async function runHook(mode, { stdin, env = process.env, workspace, debug = false } = {}) {
  // … existing top-level body, with process.exit(N) replaced as below.
}
```

For each `process.exit(n)`:
- If it's in the *direct body* of `runHook`, replace with `return { exitCode: n };`.
- If it's in a *nested helper function* called from `runHook`, replace with `throw new ExitSignal(n);` and wrap the body of `runHook` in `try { … } catch (e) { if (e instanceof ExitSignal) return { exitCode: e.code }; throw e; }`.

The shell guard at the bottom of the file:

```js
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const isMain = process.argv[1]
  && (() => {
    try {
      return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
      return false;
    }
  })();

if (isMain) {
  const args = parseArgs(process.argv);
  const stdin = await readStdin();
  let parsed = null;
  try { parsed = stdin ? JSON.parse(stdin) : null; } catch { parsed = null; }
  runHook(args.mode, { stdin: parsed, workspace: args.workspace, debug: args.debug })
    .then(({ exitCode }) => process.exit(exitCode))
    .catch((err) => {
      process.stderr.write(`hook error: ${err.stack || err.message}\n`);
      process.exit(2); // fail-closed
    });
}
```

Note: the import of `ExitSignal` from a test-only directory is awkward. **Move `exit-signal.js` to `system/scripts/lib/exit-signal.js` instead** so it's a normal source-tree dependency. Update Task 1 reference accordingly (or fix retroactively by moving the file).

- [ ] **Step 3: Move `exit-signal.js` to `system/scripts/lib/`**

```bash
mkdir -p system/scripts/lib
git mv system/tests/lib/exit-signal.js system/scripts/lib/exit-signal.js
```

Update its import in `claude-code.js` to `'../lib/exit-signal.js'` and any future imports from harness lib to `'../../scripts/lib/exit-signal.js'`.

- [ ] **Step 4: Run existing tests to confirm no regression**

Run: `npm run test:unit` (or `npm test` pre-split)
Expected: all 108 units pass.

- [ ] **Step 5: Smoke-test the hook manually**

```bash
echo '{}' | node system/scripts/hooks/claude-code.js --on-stop --workspace /tmp; echo "exit=$?"
```
Expected: `exit=0` (drains nothing, but the entry path works).

- [ ] **Step 6: Commit**

```bash
git add system/scripts/hooks/claude-code.js system/scripts/lib/exit-signal.js
git commit -m "refactor(hooks): extract runHook(mode, opts) returning {exitCode}

Prepares for in-process invocation by the e2e harness. ExitSignal
replaces direct process.exit calls inside the hook body so the
harness can capture the intended exit code without exiting the
test runner."
```

---

## Task 11: Implement `scenario.js` (the orchestrator)

**Files:**
- Create: `system/tests/lib/scenario.js`

This is the integration point. It accepts `{fixture, steps, mode, expect, …}`, seeds the tempdir, installs determinism layers, runs steps, captures output, and asserts (or writes snapshots).

- [ ] **Step 1: Write `scenario.js`**

```js
// system/tests/lib/scenario.js
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

import { installClock, uninstallClock } from './clock.js';
import { installRandom, uninstallRandom } from './ids.js';
import { installStubs, uninstallStubs, getLedger, hasBlockEvents } from './stubs.js';
import { seedFixture, makeTempdir, cleanupTempdir } from './fixtures.js';
import { captureTree, compareTrees, writeTreeAtomic, loadExpectedTree, formatDiff } from './snapshot.js';
import { normalize } from './normalize.js';
import { ExitSignal } from '../../scripts/lib/exit-signal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const FIXTURES_DIR = join(REPO_ROOT, 'system/tests/fixtures');

const DEFAULT_TREE_IGNORE = [
  'user-data/runtime/state/telemetry/**',
  'user-data/runtime/state/jobs/**/*.lock',
  'user-data/runtime/state/jobs/**/*.tmp',
  '**/.DS_Store',
];

const SUBSYSTEM_DEFAULT_MODE = {
  hooks: 'subprocess',
  install: 'subprocess',
};

function pickDefaultMode(fixturePath) {
  const subsystem = fixturePath.split('/')[0];
  return SUBSYSTEM_DEFAULT_MODE[subsystem] ?? 'inproc';
}

export async function runScenario(opts) {
  const {
    fixture,
    steps,
    clock = '2026-01-01T00:00:00Z',
    seed = 'none',
    mode = pickDefaultMode(fixture),
    expect = { tree: true, io: false, network: false },
    normalize: extraNormalizers = [],
    stubs = { fetch: [], spawn: [] },
  } = opts;

  const fixtureDir = join(FIXTURES_DIR, fixture);
  if (!existsSync(fixtureDir)) {
    throw new Error(`fixture not found: ${fixtureDir}`);
  }

  const tempdir = makeTempdir();
  let success = false;

  try {
    seedFixture({ fixtureDir, seed, tempdir, repoRoot: REPO_ROOT });

    const ioCaptures = [];

    if (mode === 'inproc') {
      installClock(clock);
      installRandom(fixture);
      installStubs(stubs);
      // process.exit monkey-patch — long-tail backstop.
      const realExit = process.exit;
      process.exit = (code) => { throw new ExitSignal(code ?? 0); };

      try {
        for (let i = 0; i < steps.length; i++) {
          ioCaptures.push(await runInprocStep(steps[i], { tempdir, scenarioEnv: scenarioEnvFor(tempdir, fixture, clock) }));
        }
      } finally {
        process.exit = realExit;
        uninstallStubs();
        uninstallRandom();
        uninstallClock();
      }
    } else {
      // subprocess mode
      const stubsFile = join(tempdir, '.stubs.json');
      writeFileSync(stubsFile, JSON.stringify(stubs));
      for (let i = 0; i < steps.length; i++) {
        ioCaptures.push(runSubprocessStep(steps[i], { tempdir, fixture, clock, stubsFile }));
      }
    }

    // Block-event guard: any unstubbed call attempted in inproc → fail.
    if (mode === 'inproc' && hasBlockEvents()) {
      throw new Error(`Scenario attempted unstubbed outbound calls. Ledger: ${JSON.stringify(getLedger(), null, 2)}`);
    }

    // Tree assertion / write.
    const ctx = { workspace: tempdir, clockMs: Date.parse(clock), extra: extraNormalizers };
    const ignore = [...DEFAULT_TREE_IGNORE, ...((typeof expect.tree === 'object' && expect.tree.ignore) || [])];
    const actualTreeRaw = captureTree(join(tempdir, 'user-data'), ignore.map((g) => g.replace(/^user-data\//, '')));
    const actualTree = mapValues(actualTreeRaw, (v) => normalize(v, ctx));

    const expectedTreeDir = join(fixtureDir, 'expected/tree/user-data');

    if (process.env.UPDATE_SNAPSHOTS === '1') {
      writeTreeAtomic(expectedTreeDir, actualTree);
    } else {
      const expectedTree = loadExpectedTree(expectedTreeDir);
      const diff = compareTrees(actualTree, expectedTree);
      if (diff.missing.length || diff.unexpected.length || diff.contentDiffs.length) {
        const out = [
          `scenario: ${fixture}`,
          `tempdir (preserved): ${tempdir}`,
          formatDiff(diff),
        ].join('\n');
        throw new Error(out);
      }
    }

    // IO and network — exit codes always asserted; full IO/ledger only when opted in.
    for (let i = 0; i < steps.length; i++) {
      const expected = steps[i].expectExit ?? 0;
      assert.equal(ioCaptures[i].exitCode, expected, `step ${i}: expected exit ${expected}, got ${ioCaptures[i].exitCode}`);
    }

    if (expect.io) {
      const ioPath = join(fixtureDir, 'expected/io.snapshot.json');
      const normalizedIo = ioCaptures.map((c, i) => ({
        step: i,
        exitCode: c.exitCode,
        stdout: normalize(c.stdout ?? '', ctx),
        stderr: normalize(c.stderr ?? '', ctx),
      }));
      if (process.env.UPDATE_SNAPSHOTS === '1') {
        writeFileSync(ioPath, JSON.stringify(normalizedIo, null, 2));
      } else {
        const expected = JSON.parse(readFileSync(ioPath, 'utf8'));
        assert.deepEqual(normalizedIo, expected, `IO mismatch in scenario ${fixture}`);
      }
    }

    if (expect.network) {
      const netPath = join(fixtureDir, 'expected/network.json');
      const ledger = getLedger();
      if (process.env.UPDATE_SNAPSHOTS === '1') {
        writeFileSync(netPath, JSON.stringify(ledger, null, 2));
      } else {
        const expected = JSON.parse(readFileSync(netPath, 'utf8'));
        assert.deepEqual(ledger, expected, `Network ledger mismatch in scenario ${fixture}`);
      }
    }

    success = true;
  } finally {
    cleanupTempdir(tempdir, success);
  }
}

function mapValues(obj, fn) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v);
  return out;
}

function scenarioEnvFor(tempdir, fixture, clock) {
  return {
    ...process.env,
    ROBIN_WORKSPACE: tempdir,
    ROBIN_CLOCK: clock,
    ROBIN_RANDOM_SEED: fixture,
  };
}

async function runInprocStep(step, { tempdir, scenarioEnv }) {
  const env = { ...scenarioEnv, ...(step.env ?? {}) };
  // Override process.env for the step.
  const savedEnv = { ...process.env };
  Object.assign(process.env, env);

  const stdoutBuf = [];
  const stderrBuf = [];
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { stdoutBuf.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderrBuf.push(String(chunk)); return true; };

  let exitCode = 0;
  try {
    if (step.run) {
      const { main } = await import('../../../bin/robin.js');
      try {
        const r = await main(step.run, env);
        exitCode = r.exitCode;
      } catch (e) {
        if (e instanceof ExitSignal) exitCode = e.code;
        else throw e;
      }
    } else if (step.hook) {
      const { runHook } = await import('../../scripts/hooks/claude-code.js');
      try {
        const r = await runHook(step.hook, { stdin: step.stdin ?? null, env, workspace: tempdir });
        exitCode = r.exitCode;
      } catch (e) {
        if (e instanceof ExitSignal) exitCode = e.code;
        else throw e;
      }
    } else if (step.writeFile) {
      const filePath = join(tempdir, step.writeFile);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, step.content ?? '');
    } else {
      throw new Error(`unknown step: ${JSON.stringify(step)}`);
    }
  } finally {
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
    // Restore env.
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }

  return { exitCode, stdout: stdoutBuf.join(''), stderr: stderrBuf.join('') };
}

function runSubprocessStep(step, { tempdir, fixture, clock, stubsFile }) {
  const env = {
    ...process.env,
    ROBIN_WORKSPACE: tempdir,
    ROBIN_CLOCK: clock,
    ROBIN_RANDOM_SEED: fixture,
    ROBIN_STUBS_FILE: stubsFile,
    ...(step.env ?? {}),
  };
  const preloads = [
    '--import', join(REPO_ROOT, 'system/tests/lib/preload-clock.mjs'),
    '--import', join(REPO_ROOT, 'system/tests/lib/preload-random.mjs'),
    '--import', join(REPO_ROOT, 'system/tests/lib/preload-stubs.mjs'),
  ];

  let nodeArgs;
  let stdinInput;
  if (step.run) {
    nodeArgs = [...preloads, join(REPO_ROOT, 'bin/robin.js'), ...step.run];
    stdinInput = '';
  } else if (step.hook) {
    nodeArgs = [...preloads, join(REPO_ROOT, 'system/scripts/hooks/claude-code.js'), `--${step.hook}`, '--workspace', tempdir];
    stdinInput = JSON.stringify(step.stdin ?? {});
  } else if (step.writeFile) {
    const filePath = join(tempdir, step.writeFile);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, step.content ?? '');
    return { exitCode: 0, stdout: '', stderr: '' };
  } else {
    throw new Error(`unknown step: ${JSON.stringify(step)}`);
  }

  const r = spawnSync('node', nodeArgs, { env, input: stdinInput, encoding: 'utf8' });
  return {
    exitCode: r.status ?? 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}
```

- [ ] **Step 2: Add a self-test for `scenario.js` (sanity check before smoke scenario)**

Create `system/tests/lib/__tests__/scenario.test.js`:

```js
import { describe, it } from 'node:test';
import { runScenario } from '../scenario.js';

describe('scenario: self-test', () => {
  it('throws when fixture does not exist', async () => {
    let threw = false;
    try { await runScenario({ fixture: 'nonexistent/x', steps: [] }); }
    catch (e) { threw = /fixture not found/.test(e.message); }
    if (!threw) throw new Error('expected fixture-not-found error');
  });
});
```

Run: `node --test system/tests/lib/__tests__/scenario.test.js`
Expected: PASS, 1 test.

- [ ] **Step 3: Commit**

```bash
git add system/tests/lib/scenario.js system/tests/lib/__tests__/scenario.test.js
git commit -m "feat(tests): add runScenario orchestrator (inproc + subprocess modes)"
```

---

## Task 12: Add `fixture-audit.test.js`

**Files:**
- Create: `system/tests/lib/fixture-audit.test.js`

- [ ] **Step 1: Write the audit test**

```js
// system/tests/lib/fixture-audit.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const FIXTURES = join(REPO_ROOT, 'system/tests/fixtures');
const E2E = join(REPO_ROOT, 'system/tests/e2e');

function listLeafFixtureDirs(root) {
  const out = [];
  if (!existsSync(root)) return out;
  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    const subdirs = entries.filter((e) => e.isDirectory());
    if (subdirs.some((d) => d.name === 'input' || d.name === 'expected')) {
      out.push(dir);
      return;
    }
    for (const d of subdirs) walk(join(dir, d.name));
  }
  walk(root);
  return out;
}

function listE2eTests(root) {
  const out = [];
  if (!existsSync(root)) return out;
  function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.test.js')) out.push(join(dir, e.name));
    }
  }
  walk(root);
  return out;
}

describe('e2e: fixture audit', () => {
  it('every fixture dir is referenced by a .test.js', () => {
    const fixtures = listLeafFixtureDirs(FIXTURES);
    const tests = listE2eTests(E2E);
    const allTestSrc = tests.map((p) => readFileSync(p, 'utf8')).join('\n');

    const orphans = [];
    for (const fix of fixtures) {
      const rel = fix.slice(FIXTURES.length + 1); // e.g. "hooks/on-pre-bash-…"
      if (!allTestSrc.includes(`fixture: '${rel}'`) && !allTestSrc.includes(`fixture: "${rel}"`)) {
        orphans.push(rel);
      }
    }
    assert.deepEqual(orphans, [], `Orphan fixture dirs: ${orphans.join(', ')}`);
  });
});
```

- [ ] **Step 2: Run the audit (should pass — no fixtures yet)**

Run: `node --test system/tests/lib/fixture-audit.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add system/tests/lib/fixture-audit.test.js
git commit -m "feat(tests): add fixture-audit to prevent orphan fixtures"
```

---

## Task 13: Add `package.json` test scripts

**Files:**
- Modify: `package.json` (scripts section)

- [ ] **Step 1: Edit `package.json`**

Replace the `"test": "node --test 'system/tests/**/*.test.js'"` line with:

```json
"test": "npm run test:unit && npm run test:e2e",
"test:unit": "node --test --test-name-pattern='^(?!e2e:)' 'system/tests/**/*.test.js'",
"test:e2e": "node --test 'system/tests/e2e/{hooks,memory,jobs}/**/*.test.js'",
```

(Preserve all other existing scripts.)

- [ ] **Step 2: Verify scripts work**

```bash
npm run test:unit
```
Expected: existing 108 + new harness unit tests pass.

```bash
npm run test:e2e
```
Expected: PASS (zero scenarios match the glob — `node:test` exits 0 on no files matched, but verify; some Node versions return 1. If 1, add `--passWithNoTests` or use a placeholder until Phase 1's smoke scenario lands in Task 14.)

If `node:test` errors on no-files-matched, work around it by deferring the `test:e2e` script addition until Task 14 lands the smoke scenario. Adjust this task to add `test:unit` only and add `test:e2e` in Task 14.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(tests): add test:unit / test:e2e npm scripts"
```

---

## Task 14: Add Phase 1 smoke scenario (`hooks/on-pre-bash-blocks-sensitive-command`)

**Files:**
- Create: `system/tests/e2e/hooks/on-pre-bash-blocks-sensitive-command.test.js`
- Create: `system/tests/fixtures/hooks/on-pre-bash-blocks-sensitive-command/input/user-data/runtime/state/telemetry/.gitkeep`
- Create (via UPDATE_SNAPSHOTS): `system/tests/fixtures/hooks/on-pre-bash-blocks-sensitive-command/expected/tree/user-data/...`

- [ ] **Step 1: Create the fixture's input dir**

```bash
mkdir -p system/tests/fixtures/hooks/on-pre-bash-blocks-sensitive-command/input/user-data/runtime/state/telemetry
touch system/tests/fixtures/hooks/on-pre-bash-blocks-sensitive-command/input/user-data/runtime/state/telemetry/.gitkeep
```

The hook writes refusals to `policy-refusals.log` under telemetry, but the spec ignores telemetry by default. The scenario's interesting assertions are: exitCode=2 (the block) and tree unchanged (everything inside ignored telemetry path doesn't show up in expected/tree/).

- [ ] **Step 2: Write the test file**

```js
// system/tests/e2e/hooks/on-pre-bash-blocks-sensitive-command.test.js
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: on-pre-bash blocks sensitive command', () => {
  it('exits 2 and leaves user-data unchanged (refusal logged to ignored telemetry path)', async () => {
    await runScenario({
      fixture: 'hooks/on-pre-bash-blocks-sensitive-command',
      clock: '2026-05-02T12:00:00Z',
      steps: [
        {
          hook: 'on-pre-bash',
          stdin: { tool_input: { command: 'cat ~/.aws/credentials' } },
          expectExit: 2,
        },
      ],
      expect: { tree: true },
    });
  });
});
```

- [ ] **Step 3: Generate the expected tree**

```bash
UPDATE_SNAPSHOTS=1 node --test system/tests/e2e/hooks/on-pre-bash-blocks-sensitive-command.test.js
```
Expected: Test passes; `system/tests/fixtures/hooks/on-pre-bash-blocks-sensitive-command/expected/tree/` is populated. Since the entire telemetry tree is ignored and nothing else changes, the expected tree contains only `.gitkeep` (or is effectively empty if `.gitkeep` is also ignored — check the output).

- [ ] **Step 4: Inspect the diff**

```bash
git status system/tests/fixtures/
git diff system/tests/fixtures/
```

Read every line. The expected/tree contents should be minimal — confirm the assertion makes sense (tree unchanged since seed had only `.gitkeep`).

- [ ] **Step 5: Run the scenario in assert mode**

```bash
node --test system/tests/e2e/hooks/on-pre-bash-blocks-sensitive-command.test.js
```
Expected: PASS.

- [ ] **Step 6: Run the full Phase 1 suite**

```bash
npm test
```
Expected: All units + the new e2e scenario pass. Time budget: <30s.

- [ ] **Step 7: Run 5 sequential local invocations to check for flake**

```bash
for i in 1 2 3 4 5; do npm run test:e2e || echo "FLAKE on run $i"; done
```
Expected: 5 clean runs.

- [ ] **Step 8: Commit**

```bash
git add system/tests/e2e/hooks/ system/tests/fixtures/hooks/
git commit -m "feat(tests): add Phase 1 smoke scenario — on-pre-bash block

End-to-end exercise of the harness: subprocess mode, hook invocation
via stdin JSON, exit-code-2 contract, tree-unchanged assertion."
```

---

# Phase 2 — Hooks (3 more) + Memory (2)

## Task 15: Add CI workflow

**Files:**
- Create: `.github/workflows/tests.yml`

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/tests.yml
name: Tests

on:
  pull_request:
  push:
    branches: [main]

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
```

- [ ] **Step 2: Validate locally**

Run: `npm run test:unit && npm run test:e2e`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/tests.yml
git commit -m "ci(tests): add unit + e2e jobs in tests.yml"
```

---

## Task 16: Scenario `hooks/on-pre-tool-use-blocks-pii-write`

**Files:**
- Create: `system/tests/e2e/hooks/on-pre-tool-use-blocks-pii-write.test.js`
- Create: `system/tests/fixtures/hooks/on-pre-tool-use-blocks-pii-write/input/user-data/memory/INDEX.md`

The hook scans `tool_input` for PII patterns; SSN-shaped strings should trigger a block (exit 2). Tree unchanged.

- [ ] **Step 1: Create input fixture**

```bash
mkdir -p system/tests/fixtures/hooks/on-pre-tool-use-blocks-pii-write/input/user-data/memory
cat > system/tests/fixtures/hooks/on-pre-tool-use-blocks-pii-write/input/user-data/memory/INDEX.md <<'EOF'
# Memory Index

streams/inbox.md (lines: 0)
EOF
```

- [ ] **Step 2: Write the test**

```js
// system/tests/e2e/hooks/on-pre-tool-use-blocks-pii-write.test.js
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: on-pre-tool-use blocks PII write', () => {
  it('exits 2 when payload contains an SSN-shaped string', async () => {
    await runScenario({
      fixture: 'hooks/on-pre-tool-use-blocks-pii-write',
      clock: '2026-05-02T12:00:00Z',
      steps: [
        {
          hook: 'on-pre-tool-use',
          stdin: {
            tool_name: 'Write',
            tool_input: {
              file_path: 'user-data/memory/notes.md',
              content: 'Alice SSN: 123-45-6789',
            },
          },
          expectExit: 2,
        },
      ],
      expect: { tree: true },
    });
  });
});
```

- [ ] **Step 3: Generate expected tree**

```bash
UPDATE_SNAPSHOTS=1 node --test system/tests/e2e/hooks/on-pre-tool-use-blocks-pii-write.test.js
```

- [ ] **Step 4: Inspect diff**

```bash
git diff system/tests/fixtures/hooks/on-pre-tool-use-blocks-pii-write/
```
Expected: `expected/tree/user-data/memory/INDEX.md` matches input (block prevented any write).

- [ ] **Step 5: Run in assert mode**

```bash
node --test system/tests/e2e/hooks/on-pre-tool-use-blocks-pii-write.test.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add system/tests/e2e/hooks/on-pre-tool-use-blocks-pii-write.test.js system/tests/fixtures/hooks/on-pre-tool-use-blocks-pii-write/
git commit -m "feat(tests): scenario — on-pre-tool-use blocks PII write"
```

---

## Task 17: Scenario `hooks/on-pre-tool-use-blocks-auto-memory-write`

**Files:**
- Create: `system/tests/e2e/hooks/on-pre-tool-use-blocks-auto-memory-write.test.js`
- Create: `system/tests/fixtures/hooks/on-pre-tool-use-blocks-auto-memory-write/input/user-data/`

The hook blocks Write/Edit/NotebookEdit calls targeting `~/.claude/projects/<workspace>/memory/*`. The scenario writes a payload pointed at such a path and asserts exit 2 + tree unchanged.

- [ ] **Step 1: Create input fixture**

```bash
mkdir -p system/tests/fixtures/hooks/on-pre-tool-use-blocks-auto-memory-write/input/user-data/runtime/config
cat > system/tests/fixtures/hooks/on-pre-tool-use-blocks-auto-memory-write/input/user-data/runtime/config/robin.config.json <<'EOF'
{ "name": "test", "tz": "UTC", "initialized": true }
EOF
```

- [ ] **Step 2: Write the test**

```js
// system/tests/e2e/hooks/on-pre-tool-use-blocks-auto-memory-write.test.js
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: on-pre-tool-use blocks auto-memory write', () => {
  it('exits 2 when tool targets ~/.claude/projects/<ws>/memory/', async () => {
    await runScenario({
      fixture: 'hooks/on-pre-tool-use-blocks-auto-memory-write',
      clock: '2026-05-02T12:00:00Z',
      steps: [
        {
          hook: 'on-pre-tool-use',
          stdin: {
            tool_name: 'Write',
            tool_input: {
              file_path: '/Users/alice/.claude/projects/-tmp-robin-test/memory/foo.md',
              content: 'should not land',
            },
          },
          expectExit: 2,
        },
      ],
      expect: { tree: true },
    });
  });
});
```

- [ ] **Step 3: Generate expected**

```bash
UPDATE_SNAPSHOTS=1 node --test system/tests/e2e/hooks/on-pre-tool-use-blocks-auto-memory-write.test.js
```

- [ ] **Step 4: Inspect diff and run in assert mode**

```bash
git diff system/tests/fixtures/hooks/on-pre-tool-use-blocks-auto-memory-write/
node --test system/tests/e2e/hooks/on-pre-tool-use-blocks-auto-memory-write.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add system/tests/e2e/hooks/on-pre-tool-use-blocks-auto-memory-write.test.js system/tests/fixtures/hooks/on-pre-tool-use-blocks-auto-memory-write/
git commit -m "feat(tests): scenario — on-pre-tool-use blocks auto-memory write"
```

---

## Task 18: Scenario `hooks/on-stop-comprehensive`

**Files:**
- Create: `system/tests/e2e/hooks/on-stop-comprehensive.test.js`
- Create: `system/tests/fixtures/hooks/on-stop-comprehensive/input/user-data/...` (skeleton-shaped seed via `seed: 'scaffold'`)

This tests the on-stop hook's two outputs: (1) drains host auto-memory dir into `inbox.md`, (2) writes `## Session — <id>` block to `session-handoff.md` and updates `hot.md`.

The host auto-memory dir is computed from `REPO_ROOT.replace(/\//g, '-')` — under test, the harness must seed an auto-memory dir matching the *tempdir* path. The fixture creates `~/.claude/projects/<slugged-tempdir>/memory/*.md` files. Achieving that without polluting the real `~/.claude` is tricky; one option is to override `homedir()` in the hook (existing path: `import { homedir } from 'node:os'`) — but we don't want to monkey-patch that for the test.

**Pragmatic approach:** the on-stop hook accepts a `--workspace` flag and computes the auto-memory dir from REPO_ROOT (the package's REPO_ROOT, not the workspace). For an in-process or subprocess test against a tempdir workspace, the auto-memory dir is *not* under the tempdir — it's under the real user's `~/.claude`. So a true e2e test of auto-memory drain requires patching `homedir()` or the auto-memory-dir computation.

**Decision for Phase 2:** the `on-stop-comprehensive` scenario covers only the **session-handoff write** half of the hook (deterministic, scoped to the workspace). The auto-memory drain half is tested by a separate scenario in a later phase, contingent on adding a `ROBIN_AUTO_MEMORY_DIR` override env var to `claude-code.js` so the test can point it inside the tempdir. **Add that override as part of this task** — it's a small, justified change.

- [ ] **Step 1: Add `ROBIN_AUTO_MEMORY_DIR` override to `claude-code.js`**

Find the `autoMemoryDir()` function (around line 62) and modify:

```js
function autoMemoryDir() {
  if (process.env.ROBIN_AUTO_MEMORY_DIR) return process.env.ROBIN_AUTO_MEMORY_DIR;
  const slug = REPO_ROOT.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', slug, 'memory');
}
```

Run unit tests: `npm run test:unit`
Expected: all units still pass.

- [ ] **Step 2: Create input fixture**

```bash
SCEN=system/tests/fixtures/hooks/on-stop-comprehensive
mkdir -p $SCEN/input/user-data/memory/{streams,self-improvement,knowledge}
mkdir -p $SCEN/input/user-data/runtime/{config,state/sessions}
mkdir -p $SCEN/input/auto-memory

cat > $SCEN/input/user-data/runtime/config/robin.config.json <<'EOF'
{ "name": "test", "tz": "UTC", "initialized": true }
EOF

cat > $SCEN/input/user-data/runtime/state/sessions.md <<'EOF'
| session_id | host | started | last_active |
| --- | --- | --- | --- |
| claude-code-test1 | claude-code | 2026-05-02T11:00:00Z | 2026-05-02T11:55:00Z |
EOF

cat > $SCEN/input/user-data/memory/streams/inbox.md <<'EOF'
# Inbox

- [fact|origin=user] existing line
EOF

cat > $SCEN/input/user-data/memory/hot.md <<'EOF'
# Hot
EOF

cat > $SCEN/input/user-data/memory/self-improvement/session-handoff.md <<'EOF'
# Session Handoff
EOF

# Stray host-auto-memory file (harness will point ROBIN_AUTO_MEMORY_DIR here).
cat > $SCEN/input/auto-memory/leak.md <<'EOF'
- [fact|origin=tool:claude] this should drain to inbox
EOF
```

- [ ] **Step 3: Write the test**

```js
// system/tests/e2e/hooks/on-stop-comprehensive.test.js
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';
import { join } from 'node:path';

describe('e2e: hooks: on-stop comprehensive (drain + handoff)', () => {
  it('drains auto-memory into inbox AND writes session-handoff block', async () => {
    await runScenario({
      fixture: 'hooks/on-stop-comprehensive',
      clock: '2026-05-02T12:00:00Z',
      steps: [
        {
          hook: 'on-stop',
          stdin: { session_id: 'claude-code-test1' },
          env: { ROBIN_AUTO_MEMORY_DIR: '__TEMPDIR__/auto-memory' },
        },
      ],
      expect: { tree: true },
    });
  });
});
```

The `__TEMPDIR__` placeholder needs harness support: extend `runInprocStep` and `runSubprocessStep` to substitute `__TEMPDIR__` with the actual tempdir in any `env` value. Add this substitution to `scenario.js` (in both step runners): before applying `env`, walk values and replace `__TEMPDIR__` with the actual tempdir path.

- [ ] **Step 4: Add `__TEMPDIR__` substitution in `scenario.js`**

In both `runInprocStep` and `runSubprocessStep`, before constructing the env, add:

```js
function substituteTempdir(envOverlay, tempdir) {
  const out = {};
  for (const [k, v] of Object.entries(envOverlay ?? {})) {
    out[k] = String(v).replace(/__TEMPDIR__/g, tempdir);
  }
  return out;
}
```

Apply to `step.env`: `const stepEnv = substituteTempdir(step.env, tempdir);` and use `stepEnv` instead.

- [ ] **Step 5: Generate expected tree**

```bash
UPDATE_SNAPSHOTS=1 node --test system/tests/e2e/hooks/on-stop-comprehensive.test.js
```

- [ ] **Step 6: Inspect diff carefully**

```bash
git diff system/tests/fixtures/hooks/on-stop-comprehensive/expected/
```

Expected:
- `inbox.md` includes the original line + a redacted version of `leak.md`'s line.
- `session-handoff.md` has a `## Session — claude-code-test1` block.
- `hot.md` has the same block.
- The `auto-memory/leak.md` is gone (drain).

If anything looks wrong, fix the input fixture or the hook logic and rerun.

- [ ] **Step 7: Run in assert mode**

```bash
node --test system/tests/e2e/hooks/on-stop-comprehensive.test.js
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add system/scripts/hooks/claude-code.js system/tests/lib/scenario.js system/tests/e2e/hooks/on-stop-comprehensive.test.js system/tests/fixtures/hooks/on-stop-comprehensive/
git commit -m "feat(tests): scenario — on-stop drain + handoff comprehensive

Adds ROBIN_AUTO_MEMORY_DIR override to claude-code.js so the harness
can point the drain target at a tempdir-scoped path. Adds __TEMPDIR__
env substitution to scenario.js for fixture-scoped path injection."
```

---

## Task 19: Scenario `memory/recall-finds-multi-entity-references`

**Files:**
- Create: `system/tests/e2e/memory/recall-finds-multi-entity-references.test.js`
- Create: `system/tests/fixtures/memory/recall-finds-multi-entity-references/input/user-data/memory/`

This is the first inproc-mode scenario, exercising `bin/robin.js recall` directly.

- [ ] **Step 1: Create input fixture**

```bash
SCEN=system/tests/fixtures/memory/recall-finds-multi-entity-references
mkdir -p $SCEN/input/user-data/memory/knowledge/people $SCEN/input/user-data/memory/streams
mkdir -p $SCEN/input/user-data/runtime/config

cat > $SCEN/input/user-data/runtime/config/robin.config.json <<'EOF'
{ "name": "test", "tz": "UTC", "initialized": true }
EOF

cat > $SCEN/input/user-data/memory/INDEX.md <<'EOF'
# Memory Index

knowledge/people/alice.md (lines: 5)
streams/inbox.md (lines: 2)
EOF

cat > $SCEN/input/user-data/memory/ENTITIES.md <<'EOF'
# Entities

## Alice
- knowledge/people/alice.md
- streams/inbox.md
- self-improvement/journal.md
EOF

cat > $SCEN/input/user-data/memory/knowledge/people/alice.md <<'EOF'
# Alice

Alice is a colleague. Works on the data team.
Met at the Q1 offsite.
Email: alice@example.com
EOF

cat > $SCEN/input/user-data/memory/streams/inbox.md <<'EOF'
# Inbox

- [fact|origin=user] Alice mentioned the new dashboard
- [task|origin=user] follow up with Alice next week
EOF

mkdir -p $SCEN/input/user-data/memory/self-improvement
cat > $SCEN/input/user-data/memory/self-improvement/journal.md <<'EOF'
# Journal

2026-05-01: Met with Alice to review priorities.
EOF
```

- [ ] **Step 2: Write the test**

```js
// system/tests/e2e/memory/recall-finds-multi-entity-references.test.js
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: memory: recall finds multi-entity references', () => {
  it('robin recall Alice --json returns hits across all 3 files', async () => {
    await runScenario({
      fixture: 'memory/recall-finds-multi-entity-references',
      clock: '2026-05-02T12:00:00Z',
      steps: [{ run: ['recall', '--json', 'Alice'] }],
      expect: { tree: true, io: true },
    });
  });
});
```

- [ ] **Step 3: Generate expected**

```bash
UPDATE_SNAPSHOTS=1 node --test system/tests/e2e/memory/recall-finds-multi-entity-references.test.js
```

- [ ] **Step 4: Inspect diff**

```bash
git diff system/tests/fixtures/memory/recall-finds-multi-entity-references/
```

Expected:
- `expected/tree/` mirrors input (recall is read-only).
- `expected/io.snapshot.json` contains a step with `exitCode: 0` and stdout JSON listing 3 hits across alice.md, inbox.md, journal.md.

- [ ] **Step 5: Run in assert mode**

```bash
node --test system/tests/e2e/memory/recall-finds-multi-entity-references.test.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add system/tests/e2e/memory/recall-finds-multi-entity-references.test.js system/tests/fixtures/memory/recall-finds-multi-entity-references/
git commit -m "feat(tests): scenario — recall finds multi-entity references"
```

---

## Task 20: Scenario `memory/index-regen-after-content-change`

**Files:**
- Create: `system/tests/e2e/memory/index-regen-after-content-change.test.js`
- Create: `system/tests/fixtures/memory/index-regen-after-content-change/input/user-data/...`

Two-step scenario: `writeFile` to mutate a topic file, then `run regenerate-memory-index`. Asserts INDEX.md picks up the new line count.

- [ ] **Step 1: Create input fixture**

```bash
SCEN=system/tests/fixtures/memory/index-regen-after-content-change
mkdir -p $SCEN/input/user-data/memory/knowledge $SCEN/input/user-data/runtime/config

cat > $SCEN/input/user-data/runtime/config/robin.config.json <<'EOF'
{ "name": "test", "tz": "UTC", "initialized": true }
EOF

cat > $SCEN/input/user-data/memory/INDEX.md <<'EOF'
# Memory Index

knowledge/work.md (lines: 2)
EOF

cat > $SCEN/input/user-data/memory/knowledge/work.md <<'EOF'
# Work
Line 1.
EOF
```

(Note: input INDEX claims 2 lines but file has 1 content line — the regen should correct it, demonstrating the test catches both discovered and re-counted files.)

- [ ] **Step 2: Write the test**

```js
// system/tests/e2e/memory/index-regen-after-content-change.test.js
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: memory: index regen after content change', () => {
  it('regenerate-memory-index updates INDEX.md line counts', async () => {
    await runScenario({
      fixture: 'memory/index-regen-after-content-change',
      clock: '2026-05-02T12:00:00Z',
      steps: [
        { writeFile: 'user-data/memory/knowledge/work.md', content: '# Work\nLine 1.\nLine 2.\nLine 3.\n' },
        { run: ['run', 'regenerate-memory-index'] },
      ],
      expect: { tree: true },
    });
  });
});
```

Verify the npm script `regenerate-memory-index` is reachable via `robin run` — the package.json has it as a top-level script (`"regenerate-memory-index": "node …"`) but `robin run <name>` operates on **jobs**, not npm scripts. Inspect `bin/robin.js` for the `run` subcommand: it dispatches to `cmdRun(rest)` from `cli/jobs.js`, which runs *jobs*. So `robin run regenerate-memory-index` only works if there's a job by that name. Check:

```bash
ls system/jobs/ | grep -i index
```

If no such job exists, this scenario uses a different invocation (e.g., a direct script call). Adjust the step to:

```js
{ run: ['__call_script__', 'system/scripts/memory/regenerate-index.js'] }
```

— but `bin/robin.js` doesn't have a `__call_script__` command. The pragmatic alternative: invoke the script via `node` directly, which means `mode: 'subprocess'` and a custom step verb… that's scope creep.

**Cleaner fix:** add a `regenerate-memory-index` job under `system/jobs/` that simply calls the script. (One-line job file with `runtime: node` frontmatter pointing at the existing script.) Or use the `npm run regenerate-memory-index` entrypoint via a `spawn` step — also scope creep.

**Recommendation:** during this task, verify `system/jobs/` for a regen job. If absent, narrow the test: assert *only* that running an existing job that regenerates indexes (e.g., `audit` if it does, or `lint` if it touches INDEX) produces the expected change. If no clean fit exists, **defer this scenario** to a follow-up and replace it in Phase 2 with `memory/lint-detects-orphan-references` or `memory/link-inserts-cross-refs` from the deferred list.

Whichever scenario you land, follow the same authoring workflow: create input → write test → `UPDATE_SNAPSHOTS=1` → inspect diff → assert mode → commit.

- [ ] **Step 3: Generate expected, inspect, run, commit**

(Same shape as Tasks 18/19. Skip the literal commands here — execute them per the workflow in Step 4–6 of Task 19.)

- [ ] **Step 4: Run the full Phase 2 suite**

```bash
npm test
```
Expected: all phase 1 + phase 2 tests pass.

- [ ] **Step 5: Run 5 sequential e2e invocations**

```bash
for i in 1 2 3 4 5; do npm run test:e2e || echo "FLAKE on run $i"; done
```
Expected: 5 clean runs.

- [ ] **Step 6: Commit**

```bash
git add system/tests/e2e/memory/index-regen-after-content-change.test.js system/tests/fixtures/memory/index-regen-after-content-change/
git commit -m "feat(tests): scenario — memory index regen after content change"
```

---

# Phase 3 — Jobs (2)

## Task 21: Scenario `jobs/run-success-records-success`

**Files:**
- Create: `system/tests/e2e/jobs/run-success-records-success.test.js`
- Create: `system/tests/fixtures/jobs/run-success-records-success/input/user-data/runtime/jobs/sample.md`

Synthetic job at `user-data/runtime/jobs/sample.md` with `runtime: node` and a trivial command (e.g., `node -e 'process.exit(0)'`). The runner picks it up because runtime/jobs is loaded from the workspace.

- [ ] **Step 1: Create the synthetic job + input fixture**

```bash
SCEN=system/tests/fixtures/jobs/run-success-records-success
mkdir -p $SCEN/input/user-data/runtime/{config,jobs,state/jobs}

cat > $SCEN/input/user-data/runtime/config/robin.config.json <<'EOF'
{ "name": "test", "tz": "UTC", "initialized": true }
EOF

cat > $SCEN/input/user-data/runtime/jobs/sample.md <<'EOF'
---
name: sample
runtime: node
script: node -e "console.log('ok')"
schedule: "0 0 1 1 *"
enabled: true
---
# Sample job

Trivial fixture job for e2e testing.
EOF

cat > $SCEN/input/user-data/runtime/state/jobs/INDEX.md <<'EOF'
# Jobs Index
EOF

touch $SCEN/input/user-data/runtime/state/jobs/failures.md
```

Verify the job-runner accepts the `script:` frontmatter form. Check:

```bash
grep -rn 'runtime:\s*script' system/jobs/ system/scripts/jobs/ | head
cat system/scripts/jobs/runner.js | head -100
```

If the runner expects a different shape (e.g., script path under `cmd:` or similar), adjust the fixture job's frontmatter to match. **Do not invent a new runtime contract** — match what the runner already supports.

- [ ] **Step 2: Write the test**

```js
// system/tests/e2e/jobs/run-success-records-success.test.js
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: jobs: run success records success', () => {
  it('robin run sample succeeds and updates state', async () => {
    await runScenario({
      fixture: 'jobs/run-success-records-success',
      clock: '2026-05-02T12:00:00Z',
      steps: [{ run: ['run', 'sample'] }],
      expect: { tree: true },
    });
  });
});
```

- [ ] **Step 3: Generate, inspect, run**

```bash
UPDATE_SNAPSHOTS=1 node --test system/tests/e2e/jobs/run-success-records-success.test.js
git diff system/tests/fixtures/jobs/run-success-records-success/
node --test system/tests/e2e/jobs/run-success-records-success.test.js
```
Expected: state file under `runtime/state/jobs/` shows the success entry; `failures.md` unchanged.

- [ ] **Step 4: Commit**

```bash
git add system/tests/e2e/jobs/run-success-records-success.test.js system/tests/fixtures/jobs/run-success-records-success/
git commit -m "feat(tests): scenario — jobs run success records success"
```

---

## Task 22: Scenario `jobs/run-failure-records-failure`

**Files:**
- Create: `system/tests/e2e/jobs/run-failure-records-failure.test.js`
- Create: `system/tests/fixtures/jobs/run-failure-records-failure/input/user-data/runtime/jobs/sample.md`

Same shape as Task 21, but the script exits non-zero. Expects `failures.md` populated, normalized.

- [ ] **Step 1: Create the synthetic failing job + fixture**

```bash
SCEN=system/tests/fixtures/jobs/run-failure-records-failure
mkdir -p $SCEN/input/user-data/runtime/{config,jobs,state/jobs}

cat > $SCEN/input/user-data/runtime/config/robin.config.json <<'EOF'
{ "name": "test", "tz": "UTC", "initialized": true }
EOF

cat > $SCEN/input/user-data/runtime/jobs/sample.md <<'EOF'
---
name: sample
runtime: node
script: node -e "process.exit(2)"
schedule: "0 0 1 1 *"
enabled: true
---
# Failing sample job
EOF

cat > $SCEN/input/user-data/runtime/state/jobs/INDEX.md <<'EOF'
# Jobs Index
EOF

touch $SCEN/input/user-data/runtime/state/jobs/failures.md
```

- [ ] **Step 2: Write the test**

Determine the runner's behavior on job failure: does `robin run sample` exit non-zero, or does it always exit 0 and just log to `failures.md`? Inspect `system/scripts/cli/jobs.js` `cmdRun` and the runner. Set `expectExit` accordingly.

```js
// system/tests/e2e/jobs/run-failure-records-failure.test.js
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: jobs: run failure records failure', () => {
  it('a failing script job is recorded in failures.md', async () => {
    await runScenario({
      fixture: 'jobs/run-failure-records-failure',
      clock: '2026-05-02T12:00:00Z',
      steps: [{ run: ['run', 'sample'], expectExit: 1 }], // adjust per actual runner
      expect: { tree: true, normalize: [{ from: /\(took \d+ms\)/g, to: '(took <N>ms)' }] },
    });
  });
});
```

- [ ] **Step 3: Generate, inspect, run, commit**

(Same workflow.)

```bash
git add system/tests/e2e/jobs/run-failure-records-failure.test.js system/tests/fixtures/jobs/run-failure-records-failure/
git commit -m "feat(tests): scenario — jobs run failure records failure"
```

---

# Phase 4 — Install (1)

## Task 23: Scenario `install/fresh-install-creates-skeleton` + CI integration

**Files:**
- Create: `system/tests/e2e/install/fresh-install-creates-skeleton.test.js`
- Create: `system/tests/fixtures/install/fresh-install-creates-skeleton/expected/...`
- Modify: `package.json` (add `test:install` script)
- Modify: `.github/workflows/tests.yml` (add `install` job)

The install scenario doesn't fit the standard `runScenario` shape — it runs `npm pack` + `npm install` against a tarball. We add a custom helper for it, but reuse the same fixture/snapshot machinery for the assertion.

- [ ] **Step 1: Create the helper**

Create `system/tests/lib/install-scenario.js`:

```js
// system/tests/lib/install-scenario.js
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeTempdir, cleanupTempdir } from './fixtures.js';
import { captureTree, compareTrees, writeTreeAtomic, loadExpectedTree, formatDiff } from './snapshot.js';
import { normalize } from './normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export async function runInstallScenario({ fixture, clock = '2026-05-02T12:00:00Z' }) {
  const fixtureDir = join(REPO_ROOT, 'system/tests/fixtures', fixture);
  const tempdir = makeTempdir();
  let success = false;

  try {
    // 1. npm pack the package.
    const pack = spawnSync('npm', ['pack', '--silent'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const tarball = pack.stdout.trim().split('\n').pop();
    const tarballPath = join(REPO_ROOT, tarball);

    // 2. npm install the tarball into tempdir.
    spawnSync('npm', ['init', '-y', '--silent'], { cwd: tempdir });
    const install = spawnSync('npm', ['install', tarballPath, '--silent'], {
      cwd: tempdir,
      env: { ...process.env, ROBIN_CLOCK: clock },
      encoding: 'utf8',
    });
    if (install.status !== 0) throw new Error(`npm install failed: ${install.stderr}`);

    // 3. Capture interesting subtree (postinstall created user-data under cwd, or wherever robin's setup script puts it).
    // Adjust this path based on actual postinstall behavior.
    const installRoot = join(tempdir, 'node_modules/robin-assistant');
    const userDataRoot = join(tempdir, 'user-data'); // if setup writes there
    const ctx = { workspace: tempdir, clockMs: Date.parse(clock), extra: [] };

    const captureRoot = existsSync(userDataRoot) ? userDataRoot : installRoot;
    const actualTreeRaw = captureTree(captureRoot, []);
    const actualTree = Object.fromEntries(
      Object.entries(actualTreeRaw).map(([k, v]) => [k, normalize(v, ctx)])
    );

    const expectedTreeDir = join(fixtureDir, 'expected/tree');
    if (process.env.UPDATE_SNAPSHOTS === '1') {
      writeTreeAtomic(expectedTreeDir, actualTree);
    } else {
      const expected = loadExpectedTree(expectedTreeDir);
      const diff = compareTrees(actualTree, expected);
      if (diff.missing.length || diff.unexpected.length || diff.contentDiffs.length) {
        throw new Error([
          `scenario: ${fixture}`,
          `tempdir (preserved): ${tempdir}`,
          formatDiff(diff),
        ].join('\n'));
      }
    }

    // Cleanup the tarball from REPO_ROOT.
    spawnSync('rm', [tarballPath]);

    success = true;
  } finally {
    cleanupTempdir(tempdir, success);
  }
}
```

Note: the actual postinstall behavior of `system/scripts/cli/setup.js` determines where `user-data/` lands. Inspect that script to confirm the expected `captureRoot` path before finalizing this helper.

- [ ] **Step 2: Add `test:install` script to package.json**

```json
"test:install": "node --test 'system/tests/e2e/install/**/*.test.js'"
```

- [ ] **Step 3: Write the test**

```js
// system/tests/e2e/install/fresh-install-creates-skeleton.test.js
import { describe, it } from 'node:test';
import { runInstallScenario } from '../../lib/install-scenario.js';

describe('e2e: install: fresh install creates skeleton', () => {
  it('npm install scaffolds user-data via postinstall', async function() {
    this.timeout(60_000);
    await runInstallScenario({
      fixture: 'install/fresh-install-creates-skeleton',
      clock: '2026-05-02T12:00:00Z',
    });
  });
});
```

(`node:test` doesn't have `this.timeout` like Mocha; instead pass `{ timeout: 60_000 }` to `it`. Adjust to: `it('…', { timeout: 60_000 }, async () => { … });`.)

- [ ] **Step 4: Generate expected tree (slow)**

```bash
UPDATE_SNAPSHOTS=1 node --test --test-timeout=60000 system/tests/e2e/install/fresh-install-creates-skeleton.test.js
```
Expected: tarball is built, install completes, expected/tree/ populated.

- [ ] **Step 5: Inspect diff carefully**

```bash
git status system/tests/fixtures/install/
git diff system/tests/fixtures/install/
```

Read every line. The expected tree should contain whatever `system/scripts/cli/setup.js` creates on a fresh install — manifest, scaffolded skeleton, etc.

- [ ] **Step 6: Run in assert mode**

```bash
node --test --test-timeout=60000 system/tests/e2e/install/fresh-install-creates-skeleton.test.js
```
Expected: PASS.

- [ ] **Step 7: Add `install` job to CI workflow**

Edit `.github/workflows/tests.yml`, add after the `e2e` job:

```yaml
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

- [ ] **Step 8: Commit**

```bash
git add system/tests/lib/install-scenario.js system/tests/e2e/install/ system/tests/fixtures/install/ package.json .github/workflows/tests.yml
git commit -m "feat(tests): Phase 4 — install scenario via npm pack + install

Adds a separate runInstallScenario helper that builds a tarball and
installs it into a tempdir, asserting the postinstall side effects
match the expected tree. Gated behind test:install to keep regular
test:e2e fast."
```

---

# Self-Review

## Spec coverage check

Each spec section has at least one task:

- §1 Architecture (layout, modes, boundary contract, normalization, tempdir lifecycle, refactor of `bin/robin.js` and `claude-code.js`, `process.exit` strategy) → Tasks 1, 9, 10, 11.
- §2 Scenario format (test file shape, fixture layout, skeleton seeding, completeness rule, ignore list, step verbs, update workflow, normalizers, defaults) → Tasks 5, 11, 14 (and propagated through every later scenario task).
- §3 Determinism + stubs (clock, ids, network/spawn block-by-default, harness-side block enforcement, scenario-scoped stubs) → Tasks 2, 3, 6, 11.
- §4 Snapshot mechanics (capture, normalize, comparison, failure output, atomic write, authoring workflow, fixture audit) → Tasks 4, 7, 11, 12.
- §5 Subsystem coverage map (9 day-one scenarios, phasing) → Tasks 14, 16–22 (smoke + 5 phase-2 + 2 phase-3 = 8 scenarios; install is task 23).
- §6 CI integration (test scripts, three-job workflow, ergonomics, rollout) → Tasks 13, 15, 23.

## Placeholder scan

- Task 20 (`memory/index-regen-after-content-change`) has a conditional in Step 2 directing the implementer to verify the existence of a regen job, with a fallback recommendation. This is action-conditional, not a placeholder — it tells the implementer *exactly* what to check and how to respond. Acceptable, but flag as a known risk: the scenario may need substitution if the runner doesn't support the assumed invocation.
- Task 22's `expectExit: 1` carries an "adjust per actual runner" note. This is also conditional, not a placeholder — concrete guidance to inspect `cmdRun` first.
- Task 23 Step 1 and Step 4 reference `system/scripts/cli/setup.js`'s postinstall behavior without reproducing it. Not a placeholder; it's a real file the implementer reads.

No "TBD"/"TODO"/"figure out later" placeholders.

## Type/name consistency

- `runScenario({fixture, steps, mode, expect, …})` — same name and shape across Tasks 11, 14, 16–22.
- `installClock(iso)` / `uninstallClock()` — same pair across Tasks 2, 8, 11.
- `installRandom(seed)` / `uninstallRandom()` — same across Tasks 3, 8, 11.
- `installStubs(spec)` / `uninstallStubs()` / `getLedger()` / `hasBlockEvents()` — same across Tasks 6, 8, 11.
- `seedFixture({fixtureDir, seed, tempdir, repoRoot})` / `makeTempdir()` / `cleanupTempdir(path, success)` — same across Tasks 5, 11.
- `captureTree(rootDir, ignoreGlobs)` / `compareTrees(actual, expected)` / `writeTreeAtomic(targetDir, contentMap)` / `loadExpectedTree(dir)` / `formatDiff(diff, opts)` — same across Tasks 7, 11, 23.
- `normalize(text, ctx)` with `ctx = {workspace, clockMs, extra}` — same across Tasks 4, 11, 23.
- `ExitSignal` from `system/scripts/lib/exit-signal.js` (after the move in Task 10) — same across Tasks 1, 10, 11.

No mismatches.

## Known risks / pre-flight

Implementer should verify these against the codebase before starting (especially in Phase 2/3):

1. **Task 20** — does `bin/robin.js run` accept `regenerate-memory-index`? If no job by that name exists, swap to `memory/lint-detects-orphan-references` from the deferred list (same shape, different scenario).
2. **Task 21/22** — does the job runner support `runtime: node` with a `script:` frontmatter field? Inspect `system/scripts/jobs/runner.js` first; adjust frontmatter to match.
3. **Task 23** — what does `system/scripts/cli/setup.js` actually do? `captureRoot` in the helper depends on its output paths.
4. **Task 13** — does `node --test` exit 0 or 1 on no files matching the glob (relevant for `test:e2e` before Task 14 lands)? If 1, defer adding `test:e2e` until Task 14.

---

# Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-03-e2e-test-harness.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Best for plans of this size (23 tasks across 4 phases).

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch with checkpoints for review. Better if you want to stay close to the work and watch each step.

**Which approach?**
