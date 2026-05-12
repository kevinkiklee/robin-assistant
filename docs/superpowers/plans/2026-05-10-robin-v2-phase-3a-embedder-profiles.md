# Robin v2 Phase 3a Implementation Plan — Embedder Profiles + ROBIN_HOME Path Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace v2's single-implementation embedder with a 3-profile pluggable system (mxbai-1024 / qwen3-4096 / gemini-3072), and move all data from `~/.robin/` to `<package_root>/user-data/`.

**Architecture:** `Embedder` interface in `src/embed/`, factory dispatches per profile read from `<package_root>/user-data/config.json`. Three migration files at `0008-embedder-<profile>.surql`; runner picks the file matching the active profile. `robin install` is multi-step idempotent (profile + migrate + daemon supervision). `robin embedder switch` re-embeds all rows in events/knowledge/entities tables on profile change. Daemon-boot health check + profile-drift detection refuse stale state.

**Tech Stack:** Node ≥ 22, ES modules. New deps: none (uses existing `@huggingface/transformers`, `surrealdb`, `@modelcontextprotocol/sdk`). Tests: `node --test`. Lint: Biome.

**Spec:** `/Users/iser/workspace/robin/robin-assistant/docs/superpowers/specs/2026-05-10-robin-v2-phase-3a-embedder-profiles-design.md` is the source of truth.

---

## File structure

```
robin-assistant-v2/
  src/
    runtime/
      home.js                                # MODIFY — packageRoot() + paths().<all>
      config.js                              # NEW — readConfig/writeConfig for config.json
    embed/
      types.js                               # NEW — Embedder JSDoc typedef
      factory.js                             # NEW — createEmbedder() per profile
      in-process.js                          # NEW — mxbai-1024 implementation
      ollama.js                              # NEW — qwen3-4096 implementation
      gemini.js                              # NEW — gemini-3072 implementation
      embedder.js                            # MODIFY/REPLACE — old createTransformersEmbedder is now factory.createEmbedder
    schema/migrations/
      0008-embedder-mxbai-1024.surql         # NEW
      0008-embedder-qwen3-4096.surql         # NEW
      0008-embedder-gemini-3072.surql        # NEW
    db/
      migrate.js                             # MODIFY — read config, skip non-active 0008 files; backup uses paths().backup
    secrets/dotenv-io.js                     # MODIFY — secretsDir / envFilePath via paths()
    integrations/_local/sqlite.js            # MODIFY — cacheDir via paths()
    integrations/chrome/sync.js              # MODIFY — cache via paths()
    integrations/lrc/sync.js                 # MODIFY — cache via paths()
    daemon/
      server.js                              # MODIFY — daemon-boot health check + drift detection + use paths()
      lock.js                                # MODIFY — daemonLock via paths()
      state.js                               # MODIFY — daemonState via paths()
    cli/
      index.js                               # MODIFY — wire `embedder` and updated `install`
      commands/
        install.js                           # REPLACE — multi-step flow with profile prompt
        embedder-switch.js                   # NEW — robin embedder switch <profile>
        migrate.js                           # MODIFY — uses paths()
    bin/robin                                # MODIFY — print resolved robinHome() on --version
  tests/
    unit/
      runtime-home.test.js                   # NEW
      runtime-config.test.js                 # NEW
      embed-factory.test.js                  # NEW
      embed-in-process.test.js               # NEW
      embed-ollama.test.js                   # NEW
      embed-gemini.test.js                   # NEW
      profile-drift.test.js                  # NEW
      embedder-switch.test.js                # NEW
      install.test.js                        # NEW
    integration/
      embedder-end-to-end.test.js            # NEW
      embedder-switch-roundtrip.test.js      # NEW
      install-flow.test.js                   # NEW
      0008-migrations.test.js                # NEW
```

---

## Task 0: ROBIN_HOME path refactor

**Files:**
- Modify: `src/runtime/home.js`
- Create: `tests/unit/runtime-home.test.js`

This is foundational; everything else depends on `paths()` resolving correctly.

- [ ] **Step 1: Rewrite `src/runtime/home.js`**

```js
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

function packageRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== '/') {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('cannot resolve package root from src/runtime/home.js');
}

export function robinHome() {
  if (process.env.ROBIN_HOME) return resolve(process.env.ROBIN_HOME);
  return join(packageRoot(), 'user-data');
}

export function paths() {
  const home = robinHome();
  return {
    home,
    db: join(home, 'db'),
    secrets: join(home, 'secrets'),
    cache: join(home, 'cache'),
    config: join(home, 'config.json'),
    backup: join(home, 'backup'),
    daemonState: join(home, '.daemon.state'),
    daemonLock: join(home, '.daemon.lock'),
    migrationsDir: join(packageRoot(), 'src', 'schema', 'migrations'),
  };
}

export async function ensureHome() {
  const p = paths();
  for (const dir of [p.home, p.db, p.secrets, p.cache, p.backup]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function packageRootDir() { return packageRoot(); }
```

- [ ] **Step 2: Tests at `tests/unit/runtime-home.test.js`**

```js
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

test('paths().home defaults to <package_root>/user-data when ROBIN_HOME unset', async () => {
  delete process.env.ROBIN_HOME;
  const { paths, packageRootDir } = await import(`../../src/runtime/home.js?cb=${Date.now()}`);
  const root = packageRootDir();
  assert.equal(paths().home, join(root, 'user-data'));
});

test('ROBIN_HOME env var overrides default', async () => {
  process.env.ROBIN_HOME = '/tmp/robin-test-override';
  const { paths } = await import(`../../src/runtime/home.js?cb=${Date.now()}`);
  assert.equal(paths().home, '/tmp/robin-test-override');
});

test('paths() includes db, secrets, cache, config, backup, daemonState, daemonLock, migrationsDir', async () => {
  process.env.ROBIN_HOME = '/tmp/robin-test-paths';
  const { paths } = await import(`../../src/runtime/home.js?cb=${Date.now()}`);
  const p = paths();
  assert.equal(p.db, '/tmp/robin-test-paths/db');
  assert.equal(p.secrets, '/tmp/robin-test-paths/secrets');
  assert.equal(p.cache, '/tmp/robin-test-paths/cache');
  assert.equal(p.config, '/tmp/robin-test-paths/config.json');
  assert.equal(p.backup, '/tmp/robin-test-paths/backup');
  assert.equal(p.daemonState, '/tmp/robin-test-paths/.daemon.state');
  assert.equal(p.daemonLock, '/tmp/robin-test-paths/.daemon.lock');
  assert.match(p.migrationsDir, /\/src\/schema\/migrations$/);
});

test('migrationsDir resolves to source tree even when ROBIN_HOME is set elsewhere', async () => {
  process.env.ROBIN_HOME = '/tmp/something';
  const { paths, packageRootDir } = await import(`../../src/runtime/home.js?cb=${Date.now()}`);
  assert.equal(paths().migrationsDir, join(packageRootDir(), 'src', 'schema', 'migrations'));
});
```

- [ ] **Step 3: Run + lint + commit**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
npm test -- tests/unit/runtime-home.test.js
npm run lint
git add src/runtime/home.js tests/unit/runtime-home.test.js
git commit -m "feat(runtime): paths() resolves to <package_root>/user-data; ROBIN_HOME env override"
```

Expected: 4 new tests pass; 504 existing tests still pass (they all set ROBIN_HOME=/tmp/... so the default path change doesn't break them).

---

## Task 1: dotenv-io + sqlite cache + daemon paths use `paths()`

**Files:**
- Modify: `src/secrets/dotenv-io.js`
- Modify: `src/integrations/_local/sqlite.js`
- Modify: `src/integrations/chrome/sync.js`
- Modify: `src/integrations/lrc/sync.js`
- Modify: `src/db/migrate.js`
- Modify: `src/daemon/lock.js`
- Modify: `src/daemon/state.js`
- Modify: `bin/robin`

- [ ] **Step 1: Audit + replace**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
grep -rln 'process.env.ROBIN_HOME\|homedir.*\.robin' src/ bin/
```

For each match, replace with the appropriate `paths().X` import. Specifically:

- `src/secrets/dotenv-io.js`: replace `secretsDir()` with `paths().secrets`; `envFilePath()` returns `join(paths().secrets, '.env')`
- `src/integrations/_local/sqlite.js`: replace cache-dir construction with `paths().cache + '/sqlite-snapshots'`
- `src/integrations/chrome/sync.js` + `src/integrations/lrc/sync.js`: import `paths` from `../../runtime/home.js` and use it
- `src/db/migrate.js`: backup tar location uses `paths().backup`
- `src/daemon/lock.js`, `src/daemon/state.js`: paths via `paths().daemonLock` / `paths().daemonState`
- `bin/robin`: `--version` output prints `robinHome()` for diagnostics

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: 504+4 = 508 tests pass. Tests that pre-seed `ROBIN_HOME` continue to work.

- [ ] **Step 3: Lint + commit**

```bash
npm run lint
git add -A
git commit -m "refactor(paths): all callers use paths() helper instead of \\\$ROBIN_HOME / homedir() directly"
```

---

## Task 2: Embedder interface + factory + readConfig

**Files:**
- Create: `src/embed/types.js`
- Create: `src/embed/factory.js`
- Create: `src/runtime/config.js`
- Create: `tests/unit/runtime-config.test.js`
- Create: `tests/unit/embed-factory.test.js`

- [ ] **Step 1: Write `src/embed/types.js`** (per spec §3)

```js
/**
 * @typedef {'mxbai-1024' | 'qwen3-4096' | 'gemini-3072'} EmbedderProfile
 *
 * @typedef {Object} Embedder
 * @property {EmbedderProfile} profile
 * @property {1024 | 4096 | 3072} dimension
 * @property {string} modelId
 * @property {(text: string) => Promise<Float32Array>} embed
 * @property {(texts: string[]) => Promise<Float32Array[]>} embedBatch
 * @property {() => Promise<void>} healthCheck
 * @property {(() => Promise<void>) | undefined} unload
 */

export const PROFILES = ['mxbai-1024', 'qwen3-4096', 'gemini-3072'];
```

- [ ] **Step 2: Write `src/runtime/config.js`** (per spec §3)

```js
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from './home.js';

export async function readConfig() {
  const p = paths().config;
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); }
  catch (e) { throw new Error(`malformed ${p}: ${e.message}`); }
}

export async function writeConfig(cfg) {
  const p = paths().config;
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o644 });
  renameSync(tmp, p);
  chmodSync(p, 0o644);
}
```

- [ ] **Step 3: Write `src/embed/factory.js`** (stub the 3 implementations until later tasks land)

```js
import { readConfig } from '../runtime/config.js';

export async function createEmbedder() {
  const cfg = await readConfig();
  if (!cfg?.embedder_profile) {
    throw new Error('no embedder profile configured. Run `robin install` first.');
  }
  switch (cfg.embedder_profile) {
    case 'mxbai-1024': {
      const { createInProcessEmbedder } = await import('./in-process.js');
      return await createInProcessEmbedder();
    }
    case 'qwen3-4096': {
      const { createOllamaEmbedder } = await import('./ollama.js');
      return await createOllamaEmbedder();
    }
    case 'gemini-3072': {
      const { createGeminiEmbedder } = await import('./gemini.js');
      return await createGeminiEmbedder();
    }
    default:
      throw new Error(`unknown embedder profile: ${cfg.embedder_profile}`);
  }
}
```

Dynamic imports so a missing implementation file doesn't break unrelated profile tests.

- [ ] **Step 4: Tests**

`tests/unit/runtime-config.test.js`:

```js
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

test('readConfig returns null when missing', async () => {
  const { readConfig } = await import(`../../src/runtime/config.js?cb=${Date.now()}`);
  assert.equal(await readConfig(), null);
});

test('writeConfig + readConfig round-trip', async () => {
  const { writeConfig, readConfig } = await import(`../../src/runtime/config.js?cb=${Date.now()}`);
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const cfg = await readConfig();
  assert.equal(cfg.embedder_profile, 'mxbai-1024');
});

test('readConfig throws on malformed JSON', async () => {
  writeFileSync(join(tmpHome, 'config.json'), '{not json', 'utf-8');
  const { readConfig } = await import(`../../src/runtime/config.js?cb=${Date.now()}`);
  await assert.rejects(() => readConfig(), /malformed/);
});

test('writeConfig is atomic temp-rename', async () => {
  const { writeConfig } = await import(`../../src/runtime/config.js?cb=${Date.now()}`);
  await writeConfig({ embedder_profile: 'qwen3-4096' });
  // No .tmp left over
  assert.equal(existsSync(join(tmpHome, 'config.json.tmp')), false);
});
```

`tests/unit/embed-factory.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

test('createEmbedder throws when config is missing', async () => {
  const { createEmbedder } = await import(`../../src/embed/factory.js?cb=${Date.now()}`);
  await assert.rejects(() => createEmbedder(), /no embedder profile configured/);
});

test('createEmbedder throws on unknown profile', async () => {
  const { writeConfig } = await import(`../../src/runtime/config.js?cb=${Date.now()}`);
  await writeConfig({ embedder_profile: 'unknown-xxx' });
  const { createEmbedder } = await import(`../../src/embed/factory.js?cb=${Date.now()}`);
  await assert.rejects(() => createEmbedder(), /unknown embedder profile/);
});
```

(Tests for actual profile creation come in T3-T5 once each implementation lands.)

- [ ] **Step 5: Run + lint + commit**

```bash
npm test -- tests/unit/runtime-config.test.js tests/unit/embed-factory.test.js
npm run lint
git add src/embed/types.js src/embed/factory.js src/runtime/config.js tests/unit/runtime-config.test.js tests/unit/embed-factory.test.js
git commit -m "feat(embed): pluggable embedder interface + factory + readConfig"
```

Expected: 6 new tests pass.

---

## Task 3: `InProcessEmbedder` (mxbai-1024)

**Files:**
- Create: `src/embed/in-process.js`
- Create: `tests/unit/embed-in-process.test.js`

- [ ] **Step 1: Implementation** (per spec §3)

```js
// src/embed/in-process.js
import { pipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/mxbai-embed-large-v1';
const DIM = 1024;

export async function createInProcessEmbedder() {
  let extractor = null;

  async function getExtractor() {
    if (extractor) return extractor;
    extractor = await pipeline('feature-extraction', MODEL);
    return extractor;
  }

  return {
    profile: 'mxbai-1024',
    dimension: DIM,
    modelId: MODEL,
    embed: async (text) => {
      const ex = await getExtractor();
      const t = await ex(text, { pooling: 'mean', normalize: true });
      return Float32Array.from(t.tolist()[0]);
    },
    embedBatch: async (texts) => {
      const ex = await getExtractor();
      const t = await ex(texts, { pooling: 'mean', normalize: true });
      return t.tolist().map((row) => Float32Array.from(row));
    },
    healthCheck: async () => {},
    unload: async () => { extractor = null; },
  };
}
```

- [ ] **Step 2: Tests**

`tests/unit/embed-in-process.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInProcessEmbedder } from '../../src/embed/in-process.js';

test('createInProcessEmbedder returns Embedder shape', async () => {
  const e = await createInProcessEmbedder();
  assert.equal(e.profile, 'mxbai-1024');
  assert.equal(e.dimension, 1024);
  assert.equal(typeof e.embed, 'function');
  assert.equal(typeof e.embedBatch, 'function');
  assert.equal(typeof e.healthCheck, 'function');
  assert.equal(typeof e.unload, 'function');
});

// Note: actual model loading is slow (~30s first time). These tests are slow.
// Use --test-concurrency=1 if needed; or skip in CI via env var.
test('embed() returns 1024-dim Float32Array', { timeout: 60_000 }, async () => {
  const e = await createInProcessEmbedder();
  const v = await e.embed('hello world');
  assert.ok(v instanceof Float32Array);
  assert.equal(v.length, 1024);
});

test('embedBatch() returns array of 1024-dim Float32Arrays', { timeout: 60_000 }, async () => {
  const e = await createInProcessEmbedder();
  const vs = await e.embedBatch(['a', 'b', 'c']);
  assert.equal(vs.length, 3);
  for (const v of vs) assert.equal(v.length, 1024);
});

test('unload() drops extractor reference', async () => {
  const e = await createInProcessEmbedder();
  await e.unload();
  // Cannot directly observe extractor=null, but next embed() should re-load (succeeds → didn't crash).
});

test('healthCheck() resolves immediately for in-process', async () => {
  const e = await createInProcessEmbedder();
  await e.healthCheck();
});
```

- [ ] **Step 3: Run + lint + commit**

```bash
npm test -- tests/unit/embed-in-process.test.js
npm run lint
git add src/embed/in-process.js tests/unit/embed-in-process.test.js
git commit -m "feat(embed): InProcessEmbedder for mxbai-1024 profile"
```

---

## Task 4: `OllamaEmbedder` (qwen3-4096)

**Files:**
- Create: `src/embed/ollama.js`
- Create: `tests/unit/embed-ollama.test.js`

- [ ] **Step 1: Implementation** (per spec §3 — full code there; copy verbatim)

- [ ] **Step 2: Tests** with mocked fetch

```js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createOllamaEmbedder } from '../../src/embed/ollama.js';

test('embed() uses /api/embed (newer endpoint) when available', async () => {
  const calls = [];
  const fakeFetch = mock.fn(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }) };
  });
  globalThis.fetch = fakeFetch;
  const e = await createOllamaEmbedder();
  const v = await e.embed('hello');
  assert.match(calls[0].url, /\/api\/embed$/);
  assert.deepEqual(Array.from(v), [0.1, 0.2, 0.3]);
});

test('embed() falls back to /api/embeddings on 404', async () => {
  let calls = 0;
  const fakeFetch = mock.fn(async (url) => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, json: async () => ({ embedding: [0.4] }) };
  });
  globalThis.fetch = fakeFetch;
  const e = await createOllamaEmbedder();
  const v = await e.embed('hello');
  assert.equal(v[0], 0.4);
});

test('healthCheck() succeeds when ollama reachable + model present', async () => {
  globalThis.fetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ models: [{ name: 'qwen3-embedding:8b' }] }),
  }));
  const e = await createOllamaEmbedder();
  await e.healthCheck();
});

test('healthCheck() throws when ollama unreachable', async () => {
  globalThis.fetch = mock.fn(async () => { throw new Error('connection refused'); });
  const e = await createOllamaEmbedder();
  await assert.rejects(() => e.healthCheck(), /connection refused/);
});

test('healthCheck() throws when model missing', async () => {
  globalThis.fetch = mock.fn(async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3' }] }) }));
  const e = await createOllamaEmbedder();
  await assert.rejects(() => e.healthCheck(), /qwen3-embedding:8b is not installed/);
});

test('OLLAMA_HOST env override', async () => {
  process.env.OLLAMA_HOST = 'http://10.0.0.5:11434';
  const calls = [];
  globalThis.fetch = mock.fn(async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ models: [{ name: 'qwen3-embedding:8b' }] }) };
  });
  // Must re-import to pick up env var (module-level constant)
  const { createOllamaEmbedder } = await import(`../../src/embed/ollama.js?cb=${Date.now()}`);
  const e = await createOllamaEmbedder();
  await e.healthCheck();
  assert.match(calls[0], /10\.0\.0\.5/);
  delete process.env.OLLAMA_HOST;
});
```

- [ ] **Step 3: Run + lint + commit**

```bash
npm test -- tests/unit/embed-ollama.test.js
npm run lint
git add src/embed/ollama.js tests/unit/embed-ollama.test.js
git commit -m "feat(embed): OllamaEmbedder for qwen3-4096 profile"
```

---

## Task 5: `GeminiApiEmbedder` (gemini-3072)

**Files:**
- Create: `src/embed/gemini.js`
- Create: `tests/unit/embed-gemini.test.js`

- [ ] **Step 1: Implementation** (per spec §3 — copy verbatim)

- [ ] **Step 2: Tests** with mocked fetch + tmp ROBIN_HOME (for `requireSecret`)

```js
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, 'secrets'), { recursive: true });
  writeFileSync(join(tmpHome, 'secrets', '.env'), 'GEMINI_API_KEY=test-key\n', 'utf-8');
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

test('embed() POSTs to embedContent endpoint', async () => {
  const calls = [];
  globalThis.fetch = mock.fn(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ embedding: { values: [0.1, 0.2] } }) };
  });
  const { createGeminiEmbedder } = await import(`../../src/embed/gemini.js?cb=${Date.now()}`);
  const e = await createGeminiEmbedder();
  const v = await e.embed('hello');
  assert.match(calls[0].url, /embedContent.*key=test-key/);
  assert.deepEqual(Array.from(v), [0.1, 0.2]);
});

test('embedBatch() POSTs to batchEmbedContents', async () => {
  globalThis.fetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ embeddings: [{ values: [0.1] }, { values: [0.2] }] }),
  }));
  const { createGeminiEmbedder } = await import(`../../src/embed/gemini.js?cb=${Date.now()}`);
  const e = await createGeminiEmbedder();
  const vs = await e.embedBatch(['a', 'b']);
  assert.equal(vs.length, 2);
});

test('429 surfaces as GeminiError.status === 429', async () => {
  globalThis.fetch = mock.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }));
  const { createGeminiEmbedder } = await import(`../../src/embed/gemini.js?cb=${Date.now()}`);
  const e = await createGeminiEmbedder();
  try {
    await e.embed('hello');
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.status, 429);
  }
});

test('healthCheck() requires GEMINI_API_KEY', async () => {
  rmSync(join(tmpHome, 'secrets', '.env'));
  writeFileSync(join(tmpHome, 'secrets', '.env'), '', 'utf-8');
  const { createGeminiEmbedder } = await import(`../../src/embed/gemini.js?cb=${Date.now()}`);
  const e = await createGeminiEmbedder();
  await assert.rejects(() => e.healthCheck(), /missing secret.*GEMINI_API_KEY/);
});
```

- [ ] **Step 3: Run + lint + commit**

```bash
npm test -- tests/unit/embed-gemini.test.js
npm run lint
git add src/embed/gemini.js tests/unit/embed-gemini.test.js
git commit -m "feat(embed): GeminiApiEmbedder for gemini-3072 profile"
```

---

## Task 6: Three 0008 migrations + migration runner update

**Files:**
- Create: `src/schema/migrations/0008-embedder-mxbai-1024.surql`
- Create: `src/schema/migrations/0008-embedder-qwen3-4096.surql`
- Create: `src/schema/migrations/0008-embedder-gemini-3072.surql`
- Modify: `src/db/migrate.js` — skip non-active 0008 files
- Create: `tests/integration/0008-migrations.test.js`

- [ ] **Step 1: Three migrations** (per spec §4 — copy verbatim, only DIMENSION + profile name differ)

- [ ] **Step 2: Migration runner update**

In `src/db/migrate.js`, find the migration-files iteration. Add the active-profile filter:

```js
import { readConfig } from '../runtime/config.js';

// ... in runMigrations():
const cfg = await readConfig();
if (!cfg?.embedder_profile) {
  throw new Error('cannot run migrations: no embedder profile configured. Run `robin install` first.');
}

for (const filename of migrationFiles) {
  if (filename.startsWith('0008-embedder-') && filename !== `0008-embedder-${cfg.embedder_profile}.surql`) {
    continue;
  }
  // ... existing apply logic
}
```

- [ ] **Step 3: Integration test for migrations**

```js
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { writeConfig } from '../../src/runtime/config.js';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

for (const profile of ['mxbai-1024', 'qwen3-4096', 'gemini-3072']) {
  test(`migrations apply for profile ${profile}; HNSW dim correct`, async () => {
    await writeConfig({ embedder_profile: profile });
    const db = await connect({ engine: 'mem://' });
    const migrationsDir = resolve(import.meta.dirname, '../../src/schema/migrations');
    await runMigrations(db, migrationsDir);

    const expectedDim = profile === 'mxbai-1024' ? 1024 : profile === 'qwen3-4096' ? 4096 : 3072;
    const goodVec = Array.from({ length: expectedDim }, () => 0.1);
    const badVec = Array.from({ length: expectedDim - 1 }, () => 0.1);

    // Good dim succeeds
    await db.query(surql`CREATE events CONTENT ${{
      source: 'cli', content: 'test', embedding: goodVec, content_hash: 'x',
    }}`).collect();

    // Wrong dim fails assertion
    await assert.rejects(() => db.query(surql`CREATE events CONTENT ${{
      source: 'cli', content: 'test2', embedding: badVec, content_hash: 'y',
    }}`).collect());

    await close(db);
  });
}

test('migrations refuse without config', async () => {
  // Don't write config
  const db = await connect({ engine: 'mem://' });
  const migrationsDir = resolve(import.meta.dirname, '../../src/schema/migrations');
  await assert.rejects(() => runMigrations(db, migrationsDir), /no embedder profile configured/);
  await close(db);
});
```

- [ ] **Step 4: Run + lint + commit**

```bash
npm test -- tests/integration/0008-migrations.test.js
npm run lint
git add src/schema/migrations/0008-*.surql src/db/migrate.js tests/integration/0008-migrations.test.js
git commit -m "feat(schema,db): three 0008-embedder-<profile> migrations + runner picks active"
```

---

## Task 7: Profile-drift detection (daemon-boot check)

**Files:**
- Modify: `src/daemon/server.js` — daemon-boot check
- Create: `tests/unit/profile-drift.test.js`

- [ ] **Step 1: Drift detection**

In `src/daemon/server.js` boot sequence (after DB connect, before any tool registration):

```js
import { readConfig } from '../runtime/config.js';

// ... in startDaemon, after dbHandle is connected:
const cfg = await readConfig();
if (!cfg?.embedder_profile) {
  console.error('[daemon] no embedder profile configured. Run `robin install` first.');
  process.exit(1);
}
const [rows] = await dbHandle
  .query(surql`SELECT * FROM type::record('runtime', 'embedder')`)
  .collect();
const runtimeProfile = rows[0]?.value?.profile;
if (runtimeProfile && runtimeProfile !== cfg.embedder_profile) {
  console.error(
    `[daemon] config drift detected:\n` +
    `  config.json says: ${cfg.embedder_profile}\n` +
    `  runtime:embedder says: ${runtimeProfile}\n` +
    `Run \`robin embedder switch ${cfg.embedder_profile}\` to migrate the schema, or revert config.json.`
  );
  process.exit(1);
}
```

- [ ] **Step 2: Embedder health check at boot**

After drift check, call `await embedder.healthCheck()`. On failure, log + exit with profile-specific instructions.

- [ ] **Step 3: Tests**

```js
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { writeConfig } from '../../src/runtime/config.js';

// Drift-detection unit test exercises the check in isolation.
// A more thorough integration test is in install-flow.test.js (Task 12).

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

test('drift check passes when config + runtime row match', async () => {
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  const migrationsDir = resolve(import.meta.dirname, '../../src/schema/migrations');
  await runMigrations(db, migrationsDir);
  const [rows] = await db.query(surql`SELECT * FROM type::record('runtime', 'embedder')`).collect();
  assert.equal(rows[0].value.profile, 'mxbai-1024');
  await close(db);
});

test('drift check detects mismatch', async () => {
  await writeConfig({ embedder_profile: 'qwen3-4096' });
  const db = await connect({ engine: 'mem://' });
  const migrationsDir = resolve(import.meta.dirname, '../../src/schema/migrations');
  await runMigrations(db, migrationsDir);
  // Now manually edit config to mxbai while runtime row says qwen3
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const cfg = JSON.parse(require('node:fs').readFileSync(join(tmpHome, 'config.json'), 'utf-8'));
  const [rows] = await db.query(surql`SELECT * FROM type::record('runtime', 'embedder')`).collect();
  assert.notEqual(cfg.embedder_profile, rows[0].value.profile);
  await close(db);
});
```

- [ ] **Step 4: Run + lint + commit**

```bash
npm test -- tests/unit/profile-drift.test.js
npm run lint
git add src/daemon/server.js tests/unit/profile-drift.test.js
git commit -m "feat(daemon): profile-drift detection + embedder health check at boot"
```

---

## Task 8: `robin embedder switch <profile>` CLI

**Files:**
- Create: `src/cli/commands/embedder-switch.js`
- Modify: `src/cli/index.js` — add `embedder` dispatcher
- Create: `tests/unit/embedder-switch.test.js`

- [ ] **Step 1: Implementation** (per spec §4)

Includes `reembedTable(db, table, embedder)` — walks rows in batches of 100, calls `embedder.embedBatch`, writes new vectors with UPDATE. Progress at `runtime:embedder.switch_progress`. Resumable.

- [ ] **Step 2: Wire dispatcher**

In `src/cli/index.js`:

```js
if (cmd === 'embedder') {
  if (argv[1] === 'switch') {
    return (await import('./commands/embedder-switch.js')).embedderSwitch(argv.slice(2));
  }
  console.error('usage: robin embedder switch <mxbai-1024|qwen3-4096|gemini-3072>');
  process.exit(1);
}
```

- [ ] **Step 3: Tests** (mock embedder, verify resumable progress)

- [ ] **Step 4: Run + lint + commit**

```bash
npm test -- tests/unit/embedder-switch.test.js
npm run lint
git add src/cli/commands/embedder-switch.js src/cli/index.js tests/unit/embedder-switch.test.js
git commit -m "feat(cli): robin embedder switch <profile> with resumable re-embed"
```

---

## Task 9: `robin install` rewrite (multi-step idempotent)

**Files:**
- Replace: `src/cli/commands/install.js`
- Modify: `src/cli/index.js` (already wires `install`; verify still works)
- Create: `tests/unit/install.test.js`

- [ ] **Step 1: Implementation** (per spec §5)

Multi-step flow:
1. Parse `--force`, `--profile`, `--i-understand` flags
2. Detect existing `~/.robin/` and print manual-migration instructions if present
3. Reinstall short-circuit if already configured (unless `--force`)
4. Profile pick (interactive or via flag)
5. Per-profile validation (Ollama probe / Gemini key check / disclosure for gemini)
6. `writeConfig({ embedder_profile })`
7. Run migrations (`runMigrations(...)`)
8. Daemon supervision wire-up (call existing Phase 2b mcp install logic)
9. Print next-step guidance

- [ ] **Step 2: Tests** (12 cases per spec §5)

- [ ] **Step 3: Run + lint + commit**

```bash
npm test -- tests/unit/install.test.js
npm run lint
git add src/cli/commands/install.js tests/unit/install.test.js
git commit -m "feat(cli): robin install — multi-step idempotent flow with profile prompt"
```

---

## Task 10: Update Phase 2 callers to use new embedder factory

**Files modified:**
- `src/daemon/server.js` (already touched in T7) — uses `createIdleEmbedder({ factory: createEmbedder, idleMs: 600_000 })`
- All integration `sync.js` files that import the old `createTransformersEmbedder` — switch to factory if any do (most use `ctx.capture` which closes over the embedder, so they don't need changes)
- Verify biographer + dream pipeline still works

- [ ] **Step 1: Audit + replace**

```bash
grep -rln 'createTransformersEmbedder' src/ tests/
```

For each, determine if the caller should:
- Use `createEmbedder()` from factory (factory pattern)
- Continue to use the embedder it was given (most cases)

Most callers receive an embedder via `ctx.capture` or similar and don't need direct changes.

- [ ] **Step 2: Daemon boot wires factory**

In `src/daemon/server.js`:

```js
import { createEmbedder } from '../embed/factory.js';

// ... where idleEmbedder was created:
const idleEmbedder = createIdleEmbedder({
  factory: createEmbedder,
  idleMs: 600_000,
});
```

- [ ] **Step 3: Run full suite**

```bash
npm test
```

Expected: all existing tests + new ones pass.

- [ ] **Step 4: Lint + commit**

```bash
npm run lint
git add -A
git commit -m "refactor(daemon,integrations): wire createEmbedder factory through idleEmbedder"
```

---

## Task 11: Integration tests + smoke + CHANGELOG + tag

**Files:**
- Create: `tests/integration/embedder-end-to-end.test.js`
- Create: `tests/integration/embedder-switch-roundtrip.test.js`
- Create: `tests/integration/install-flow.test.js`
- Modify: `CHANGELOG.md` — prepend alpha.8a entry

- [ ] **Step 1-3: Write integration tests** (per spec §6)

- [ ] **Step 4: Smoke test daemon boot for each profile**

```bash
# mxbai
ROBIN_HOME=/tmp/robin-smoke-mxbai node bin/robin install --profile mxbai-1024
ROBIN_HOME=/tmp/robin-smoke-mxbai node src/daemon/server.js &
DAEMON_PID=$!
sleep 5
cat /tmp/robin-smoke-mxbai/.daemon.state | head -3
kill $DAEMON_PID
sleep 2
```

Repeat for qwen3 (if Ollama running) and gemini (if API key set, optional).

- [ ] **Step 5: CHANGELOG entry**

```markdown
## [6.0.0-alpha.8a] — 2026-05-10

Phase 3a: pluggable embedder profiles + ROBIN_HOME path refactor.

- **ROBIN_HOME path refactor:** Robin's data root moves from `~/.robin/` to `<package_root>/user-data/`, matching v1's pattern. `ROBIN_HOME` env var override still honored. Existing `~/.robin/` data is detected on first install with manual-migration instructions.
- **Pluggable embedder interface:** `Embedder` typedef + factory pattern. Three implementations:
  - `mxbai-1024` (in-process via `@huggingface/transformers`, MTEB retrieval ~60, default)
  - `qwen3-4096` (via Ollama localhost HTTP, MTEB retrieval ~68)
  - `gemini-3072` (via Google AI Studio API, MTEB retrieval ~68, privacy disclosure required)
- **Three migration files** at `0008-embedder-<profile>.surql`. Migration runner picks the file matching the active profile. `runtime:embedder` row enables drift detection.
- **`robin install`** now multi-step idempotent: profile prompt → migrate → daemon supervision. `--profile <name>` non-interactive flag for unattended deploys; `--i-understand` required for gemini-3072 in non-interactive mode.
- **`robin embedder switch <profile>`** CLI: drops + redefines HNSW indexes on events/knowledge/entities, re-embeds all rows resumably, updates config.
- **Profile-drift detection** at daemon-boot: refuses to start when config.json and runtime:embedder disagree.
- **Daemon-boot embedder health check** per profile (Ollama reachable + model present; Gemini key set).
- **`bge-small-en-v1.5@384`** is no longer the active embedder. Phase 1's migration 0002 stays in history but is superseded by 0008.

Phase 3b candidates (separate spec): v1 → v2 migrator + 3 missing integrations (github read, spotify read, letterboxd) + 30-day backup auto-prune + encryption decision.
```

- [ ] **Step 6: Commit + tag**

```bash
git add CHANGELOG.md tests/integration/embedder-*.test.js tests/integration/install-flow.test.js
git commit -m "test(3a): integration tests + CHANGELOG for v6.0.0-alpha.8a"
git tag v6.0.0-alpha.8a
git tag -l 'v6.0.0-alpha*'
```

Expected: tag landed; full suite green; lint clean.
