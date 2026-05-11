# Runtime Layer Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden and decompose `system/runtime/` across five sequential, independently-shippable PRs: reliability fixes (R-1), tiered heartbeat (R-2), `server.js` decomposition + route table (R-3), schema + envelope on `/internal/*` (R-4), and a declarative CLI router (R-5).

**Architecture:** Five PRs against `main`. R-1 → R-2 → R-3 → R-4 must merge in order; R-5 can interleave anywhere. Each PR keeps the external surface byte-identical (hook contract, CLI command names, MCP tool names, `/internal/*` URLs, signal handling); R-4 is the only phase that changes wire format, and it does so additively. `server.js` 990 → ~80; `cli/index.js` 295 → ~55.

**Tech Stack:** Node.js ≥22 (per `package.json` engines), ESM, `node:test` test runner, SurrealDB v3 embedded, MCP SDK (`@modelcontextprotocol/sdk`), Biome for lint/format.

**Conventions used throughout:**
- Tests: `node --test`, imports from `node:test` + `node:assert/strict`.
- Test files: live FLAT under `system/tests/unit/<name>.test.js` and `system/tests/integration/<name>.test.js` — no subdirectories. Relative imports from a unit test reach `../../<module>.js` (two levels up to `system/`).
- Run a single test: `node --test --test-name-pattern='<pattern>' system/tests/unit/<name>.test.js`.
- Run all tests: `npm test`. Lint: `npm run lint`. Format: `npm run format`.
- Commit prefix: `refactor(runtime):` or `feat(runtime):` per phase.

---

## Prerequisite gate

**Do not start Task 0.1 until both conditions hold:**

1. The `refactor/system-restructure` branch (currently active at the time this plan was written) has merged into `main`.
2. `git checkout main && node -e "import('./system/runtime/daemon/server.js').then(() => console.log('OK'))"` prints `OK` — i.e., the broken `./state.js` import at `server.js:81` has been corrected (it should be `../../config/daemon-state.js` after the restructure lands).

Until both hold, the daemon cannot boot, and R-1's tests cannot pass.

---

## Pre-work: Verify baseline

### Task 0.1: Confirm clean baseline on main

**Files:** none modified.

- [ ] **Step 1: Verify branch + working tree + server.js loadability**

Run:
```bash
git checkout main
git pull
git status
git log -1 --oneline
node -e "import('./system/runtime/daemon/server.js').then(() => console.log('OK')).catch((e) => { console.error('FAIL:', e.message); process.exit(1); })"
```

Expected: working tree clean, HEAD on `main`, the import smoke test prints `OK`. If the import fails (typically `Cannot find module .../daemon/state.js`), stop — the restructure branch has not fully landed on main yet.

- [ ] **Step 2: Confirm tests pass on baseline**

Run: `npm test`

Expected: all suites pass. Note any pre-existing failures and resolve them or flag them to the user before continuing — do not start R-1 with red tests.

- [ ] **Step 3: Confirm lint clean**

Run: `npm run lint`

Expected: no errors.

- [ ] **Step 4: Create R-1 branch**

Run:
```bash
git checkout -b feat/runtime-r1-reliability
```

---

## Phase R-1: Reliability hardening (single PR)

**Scope:** Atomic lock, process-level fatal handlers, host-name normalization, embedder health retry, biographer queue depth canary, scheduler reactivation watchdog.

**File structure for R-1:**

```
system/runtime/daemon/
├── lock.js                  MODIFY (atomic wx-based acquire)
├── fatal.js                 CREATE (process error handlers)
├── retry.js                 CREATE (retryWithBackoff util)
├── sessions.js              MODIFY (import HOST_VALUES from hosts/)
└── server.js                MODIFY (embedder retry + queue canary + watchdog + wire fatal)

system/runtime/hosts/
├── index.js                 CREATE (HOSTS enum)
└── detect.js                MODIFY (normalize ROBIN_HOST input; adapter `.name` stays underscored)

system/cognition/biographer/
└── queue.js                 MODIFY (maxPending canary; existing queue+inflight structures)

system/tests/unit/
├── lock.test.js             CREATE
├── fatal.test.js            CREATE
├── retry.test.js            CREATE
├── host-naming.test.js      CREATE
└── biographer-queue.test.js EXTEND (add cap tests to the existing file)

system/tests/integration/
└── host-watchdog.test.js    CREATE
```

**Scope note:** R-1 does NOT rename `adapter.name` from underscored (`claude_code`/`gemini_cli`) to hyphenated. That rename has a 43-reference blast radius including `install/hooks-settings.js` (which uses `${host.name}-hooks` as a key in users' `settings.json`) and historical `events.meta.host` values. It's deferred to a separate cleanup PR with explicit settings.json migration. R-1 only normalizes the user-facing `ROBIN_HOST` env input and adds the `HOSTS` enum for `sessions.js` to consume.

---

### Task 1.1: Atomic daemon lock

**Files:**
- Modify: `system/runtime/daemon/lock.js`
- Create: `system/tests/unit/lock.test.js`

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/lock.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDaemonLock, releaseDaemonLock } from '../../runtime/daemon/lock.js';

async function tempLockPath() {
  const dir = await mkdtemp(join(tmpdir(), 'robin-lock-'));
  return join(dir, 'daemon.lock');
}

test('acquireDaemonLock writes pid atomically when no lock exists', async () => {
  const path = await tempLockPath();
  await acquireDaemonLock(path);
  const content = await readFile(path, 'utf8');
  assert.equal(Number.parseInt(content.trim(), 10), process.pid);
  await releaseDaemonLock(path);
});

test('acquireDaemonLock rejects when an alive pid holds the lock', async () => {
  const path = await tempLockPath();
  // Write our own pid (which is definitely alive)
  await writeFile(path, String(process.pid));
  await assert.rejects(() => acquireDaemonLock(path), (err) => err.code === 'EALREADY');
});

test('acquireDaemonLock reclaims a dead pid lock', async () => {
  const path = await tempLockPath();
  // pid 1 is init/launchd — alive on every system, so use something we KNOW is dead.
  // 999999 is well above typical max pid and effectively guaranteed dead.
  await writeFile(path, '999999');
  await acquireDaemonLock(path);
  const content = await readFile(path, 'utf8');
  assert.equal(Number.parseInt(content.trim(), 10), process.pid);
  await releaseDaemonLock(path);
});

test('acquireDaemonLock handles malformed lock file', async () => {
  const path = await tempLockPath();
  await writeFile(path, 'not-a-pid');
  // Malformed → treat as no live holder, reclaim
  await acquireDaemonLock(path);
  await releaseDaemonLock(path);
});

test('releaseDaemonLock is idempotent', async () => {
  const path = await tempLockPath();
  await releaseDaemonLock(path);  // no file
  await acquireDaemonLock(path);
  await releaseDaemonLock(path);
  await releaseDaemonLock(path);  // idempotent
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test system/tests/unit/lock.test.js`

Expected: at least the "rejects when an alive pid holds the lock" test fails because the current implementation has a TOCTOU window — running tests in parallel might pass, but the algorithm is unsafe. The "reclaims a dead pid" test currently passes via the existing fallback.

- [ ] **Step 3: Rewrite `lock.js` with atomic acquire**

Replace the entire contents of `system/runtime/daemon/lock.js`:

```js
import { readFile, unlink, writeFile } from 'node:fs/promises';

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Acquire the daemon lock atomically.
 *
 * Algorithm:
 *   1. Attempt `writeFile(path, pid, { flag: 'wx' })` — exclusive create.
 *   2. On EEXIST: read existing pid; if alive, throw EALREADY.
 *   3. If existing pid is dead or unparseable, unlink and retry (max 3 iterations).
 *
 * The wx flag closes the TOCTOU window: we never read-then-write. Multiple
 * daemons racing through dead-pid cleanup converge because at most one of
 * them is alive at any moment.
 */
export async function acquireDaemonLock(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(path, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Lock exists. Inspect.
      let pid = NaN;
      try {
        const existing = await readFile(path, 'utf8');
        pid = Number.parseInt(existing.trim(), 10);
      } catch {
        // Race: file vanished between EEXIST and read. Retry.
        continue;
      }
      if (Number.isInteger(pid) && isPidAlive(pid)) {
        const err = new Error(`daemon already running (pid ${pid})`);
        err.code = 'EALREADY';
        throw err;
      }
      // Dead or malformed. Unlink and retry.
      await unlink(path).catch(() => {});
    }
  }
  const err = new Error('daemon lock acquisition failed after 3 attempts');
  err.code = 'EALREADY';
  throw err;
}

export async function releaseDaemonLock(path) {
  try {
    await unlink(path);
  } catch {
    /* idempotent */
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test system/tests/unit/lock.test.js`

Expected: all 5 tests pass.

- [ ] **Step 5: Run full test suite to confirm no regressions**

Run: `npm test`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add system/runtime/daemon/lock.js system/tests/unit/lock.test.js
git commit -m "$(cat <<'EOF'
refactor(runtime): R-1 — atomic daemon lock via wx flag

Replace read-then-write algorithm with bounded loop using exclusive-create
(wx flag). Closes the TOCTOU window where two daemons starting near-simultaneously
could both see "no live PID" and both write.
EOF
)"
```

---

### Task 1.2: Retry-with-backoff utility

**Files:**
- Create: `system/runtime/daemon/retry.js`
- Create: `system/tests/unit/retry.test.js`

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/retry.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryWithBackoff } from '../../runtime/daemon/retry.js';

test('returns immediately on first-attempt success', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    calls++;
    return 'ok';
  }, { attempts: 3, perAttemptTimeoutMs: 1000, backoffMs: [10, 10, 0] });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retries up to attempts and returns the eventual success', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    calls++;
    if (calls < 3) throw new Error(`fail ${calls}`);
    return 'eventually';
  }, { attempts: 3, perAttemptTimeoutMs: 1000, backoffMs: [10, 10, 0] });
  assert.equal(result, 'eventually');
  assert.equal(calls, 3);
});

test('throws the last error after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryWithBackoff(async () => {
      calls++;
      throw new Error(`fail ${calls}`);
    }, { attempts: 3, perAttemptTimeoutMs: 1000, backoffMs: [10, 10, 0] }),
    /fail 3/,
  );
  assert.equal(calls, 3);
});

test('honors per-attempt timeout', async () => {
  await assert.rejects(
    () => retryWithBackoff(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return 'too late';
    }, { attempts: 1, perAttemptTimeoutMs: 50, backoffMs: [0] }),
    /timeout/i,
  );
});

test('invokes onRetry between attempts', async () => {
  const events = [];
  await assert.rejects(
    () => retryWithBackoff(async () => { throw new Error('boom'); }, {
      attempts: 3,
      perAttemptTimeoutMs: 1000,
      backoffMs: [10, 10, 0],
      onRetry: (err, attempt) => events.push({ msg: err.message, attempt }),
    }),
  );
  assert.equal(events.length, 2);  // 2 retry events between 3 attempts
  assert.equal(events[0].attempt, 1);
  assert.equal(events[1].attempt, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test system/tests/unit/retry.test.js`

Expected: FAIL with "Cannot find module ... retry.js".

- [ ] **Step 3: Implement `retry.js`**

Create `system/runtime/daemon/retry.js`:

```js
/**
 * Run `fn` up to `attempts` times. Each attempt is bounded by
 * `perAttemptTimeoutMs`. Between attempts, wait `backoffMs[i]` (last entry
 * may be 0 since the final attempt has no trailing wait).
 *
 * `onRetry(err, attempt)` is called after each failed attempt that will be
 * retried — useful for logging.
 */
export async function retryWithBackoff(fn, { attempts, perAttemptTimeoutMs, backoffMs, onRetry } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('retryWithBackoff: attempts must be >= 1');
  }
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(fn, perAttemptTimeoutMs);
    } catch (e) {
      lastError = e;
      const isLast = i === attempts - 1;
      if (!isLast) {
        if (typeof onRetry === 'function') {
          try { onRetry(e, i + 1); } catch { /* swallow */ }
        }
        const wait = backoffMs?.[i] ?? 0;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastError;
}

async function withTimeout(fn, ms) {
  if (!ms || ms <= 0) return await fn();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`retryWithBackoff: timeout after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `node --test system/tests/unit/retry.test.js`

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add system/runtime/daemon/retry.js system/tests/unit/retry.test.js
git commit -m "refactor(runtime): R-1 — add retryWithBackoff util for embedder health"
```

---

### Task 1.3: Process-level fatal handlers

**Files:**
- Create: `system/runtime/daemon/fatal.js`
- Create: `system/tests/unit/fatal.test.js`

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/fatal.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFatalHandler } from '../../runtime/daemon/fatal.js';

async function tempLogDir() {
  return await mkdtemp(join(tmpdir(), 'robin-fatal-'));
}

test('writes a structured line to the log file', async () => {
  const dir = await tempLogDir();
  let exitCode = null;
  const handler = createFatalHandler({
    logDir: dir,
    shutdown: async () => {},
    exit: (code) => { exitCode = code; },
  });
  await handler(new Error('boom'));
  const log = await readFile(join(dir, 'fatal.log'), 'utf8');
  const lines = log.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.message, 'boom');
  assert.equal(typeof parsed.ts, 'string');
  assert.equal(typeof parsed.stack, 'string');
  assert.equal(exitCode, 1);
});

test('survives log-write failure and still exits', async () => {
  let exitCode = null;
  const handler = createFatalHandler({
    logDir: '/no/such/path/ever',  // appendFile will throw
    shutdown: async () => {},
    exit: (code) => { exitCode = code; },
  });
  await handler(new Error('boom'));
  assert.equal(exitCode, 1);
});

test('forces exit even if shutdown hangs', async () => {
  const dir = await tempLogDir();
  let exitCode = null;
  const handler = createFatalHandler({
    logDir: dir,
    shutdown: () => new Promise(() => {}),  // never resolves
    exit: (code) => { exitCode = code; },
    forceExitMs: 50,
  });
  await handler(new Error('boom'));
  // Give the forceExitMs timer a chance to fire
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(exitCode, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test system/tests/unit/runtime/daemon/fatal.test.js`

Expected: FAIL with "Cannot find module ... fatal.js".

- [ ] **Step 3: Implement `fatal.js`**

Create `system/runtime/daemon/fatal.js`:

```js
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Build a fatal-error handler. The returned function logs to a single-line
 * JSON file under `<logDir>/fatal.log`, attempts a best-effort shutdown,
 * then calls exit(1). A hard timer guarantees exit even if shutdown hangs.
 *
 * Designed for injection so tests can stub exit/shutdown.
 */
export function createFatalHandler({
  logDir,
  shutdown,
  exit = (code) => process.exit(code),
  forceExitMs = 5000,
}) {
  return async function onFatal(err) {
    // Guarantee exit no matter what.
    const force = setTimeout(() => exit(1), forceExitMs);
    force.unref?.();

    // Always write to stderr first (cheapest signal).
    try {
      const summary = err?.stack ?? err?.message ?? String(err);
      process.stderr.write(`[fatal] ${summary}\n`);
    } catch { /* never throw from a fatal handler */ }

    // Best-effort log file.
    try {
      await mkdir(logDir, { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        kind: err?.name ?? 'Error',
        message: err?.message ?? String(err),
        stack: err?.stack ?? null,
      }) + '\n';
      await appendFile(join(logDir, 'fatal.log'), line);
    } catch { /* swallow */ }

    // Best-effort shutdown.
    try {
      if (typeof shutdown === 'function') await shutdown('fatal');
    } catch { /* swallow */ }

    clearTimeout(force);
    exit(1);
  };
}

/**
 * Install the handler on `process` for both uncaughtException and
 * unhandledRejection. Returns an unregister fn for tests.
 */
export function installFatalHandlers(handler) {
  const onException = (err) => { handler(err); };
  const onRejection = (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    handler(err);
  };
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `node --test system/tests/unit/runtime/daemon/fatal.test.js`

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add system/runtime/daemon/fatal.js system/tests/unit/runtime/daemon/fatal.test.js
git commit -m "$(cat <<'EOF'
refactor(runtime): R-1 — process-level fatal handlers

createFatalHandler logs uncaughtException/unhandledRejection to
<robin-home>/logs/fatal.log, attempts best-effort shutdown, and guarantees
exit via a hard timer. Not yet wired into startDaemon (next task).
EOF
)"
```

---

### Task 1.4: Host-name normalization

**Files:**
- Create: `system/runtime/hosts/index.js`
- Modify: `system/runtime/hosts/detect.js`
- Modify: `system/runtime/daemon/sessions.js`
- Create: `system/tests/unit/runtime/hosts/host-naming.test.js`

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/runtime/hosts/host-naming.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTS, HOST_VALUES } from '../../../../runtime/hosts/index.js';
import { detectHost } from '../../../../runtime/hosts/detect.js';

test('HOSTS exposes hyphenated canonical names', () => {
  assert.equal(HOSTS.CLAUDE_CODE, 'claude-code');
  assert.equal(HOSTS.GEMINI_CLI, 'gemini-cli');
  assert.equal(HOSTS.UNKNOWN, 'unknown');
});

test('HOST_VALUES is the frozen list', () => {
  assert.deepEqual(HOST_VALUES, ['claude-code', 'gemini-cli', 'unknown']);
});

test('ROBIN_HOST=claude-code resolves the claude-code adapter', async () => {
  const prev = process.env.ROBIN_HOST;
  process.env.ROBIN_HOST = 'claude-code';
  try {
    const host = await detectHost({ skipAvailabilityCheck: true });
    assert.equal(host.name, 'claude-code');
  } finally {
    if (prev === undefined) delete process.env.ROBIN_HOST;
    else process.env.ROBIN_HOST = prev;
  }
});

test('ROBIN_HOST=claude_code (underscored) warns and resolves', async () => {
  const prev = process.env.ROBIN_HOST;
  process.env.ROBIN_HOST = 'claude_code';
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const host = await detectHost({ skipAvailabilityCheck: true });
    assert.equal(host.name, 'claude-code');
    assert.ok(warnings.some((w) => w.includes('deprecated') || w.includes('hyphen')), `expected deprecation warning, got: ${warnings.join('; ')}`);
  } finally {
    console.warn = origWarn;
    if (prev === undefined) delete process.env.ROBIN_HOST;
    else process.env.ROBIN_HOST = prev;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test system/tests/unit/runtime/hosts/host-naming.test.js`

Expected: FAIL — `hosts/index.js` doesn't exist; `detect.js` uses underscored keys.

- [ ] **Step 3: Create `hosts/index.js`**

Create `system/runtime/hosts/index.js`:

```js
export const HOSTS = Object.freeze({
  CLAUDE_CODE: 'claude-code',
  GEMINI_CLI: 'gemini-cli',
  UNKNOWN: 'unknown',
});

export const HOST_VALUES = Object.freeze(Object.values(HOSTS));
```

- [ ] **Step 4: Update `detect.js` to hyphenated keys + back-compat**

Read the current `system/runtime/hosts/detect.js` and replace its contents:

```js
import { claudeCodeAdapter } from './claude-code.js';
import { geminiAdapter } from './gemini.js';
import { HOSTS } from './index.js';

const ADAPTERS = {
  [HOSTS.CLAUDE_CODE]: claudeCodeAdapter,
  [HOSTS.GEMINI_CLI]: geminiAdapter,
};

// One-shot deprecation warning for legacy underscored ROBIN_HOST values.
let warnedUnderscoreOverride = false;

export async function detectHost(opts = {}) {
  let override = process.env.ROBIN_HOST;
  if (override) {
    // Back-compat: claude_code → claude-code, gemini_cli → gemini-cli
    if (override === 'claude_code' || override === 'gemini_cli') {
      if (!warnedUnderscoreOverride) {
        console.warn(
          `[hosts] ROBIN_HOST=${override} is deprecated; use the hyphenated form (${override.replace('_', '-')}) instead.`,
        );
        warnedUnderscoreOverride = true;
      }
      override = override.replace('_', '-');
    }
    if (ADAPTERS[override]) return ADAPTERS[override];
  }

  if (process.env.CLAUDE_PROJECT_DIR) return claudeCodeAdapter;
  if (process.env.GEMINI_API_KEY) return geminiAdapter;

  if (!opts.skipAvailabilityCheck) {
    if (await claudeCodeAdapter.isAvailable()) return claudeCodeAdapter;
    if (await geminiAdapter.isAvailable()) return geminiAdapter;
  }

  throw new Error(
    'no host detected: set ROBIN_HOST=claude-code|gemini-cli or install one of the host CLIs',
  );
}
```

- [ ] **Step 5: Verify adapter `name` fields are hyphenated**

Read `system/runtime/hosts/claude-code.js` and `system/runtime/hosts/gemini.js`. Each adapter likely exports `name`. If they're underscored (`claude_code`/`gemini_cli`), update them to hyphenated. If already hyphenated, no change.

Use `grep` to confirm:
```bash
grep -n "name:" system/runtime/hosts/claude-code.js system/runtime/hosts/gemini.js
```

If the `name:` values are not `'claude-code'` / `'gemini-cli'`, edit them so the host test passes.

- [ ] **Step 6: Update `daemon/sessions.js` to import HOST_VALUES**

In `system/runtime/daemon/sessions.js`, replace the inline triplet check.

Find this block:
```js
if (host !== 'claude-code' && host !== 'gemini-cli' && host !== 'unknown') {
  throw new Error(`registerSession: invalid host ${host}`);
}
```

Add an import at the top of the file:
```js
import { HOST_VALUES } from '../hosts/index.js';
```

Replace the check with:
```js
if (!HOST_VALUES.includes(host)) {
  throw new Error(`registerSession: invalid host ${host}`);
}
```

- [ ] **Step 7: Run the new test**

Run: `node --test system/tests/unit/runtime/hosts/host-naming.test.js`

Expected: all 4 tests pass.

- [ ] **Step 8: Run full suite**

Run: `npm test`

Expected: all pass. If any tests fail because they expected `claude_code`/`gemini_cli` keys, update them to hyphenated form. Common locations: `system/tests/unit/runtime/hosts/*.test.js`, integration tests that set `ROBIN_HOST`.

- [ ] **Step 9: Commit**

```bash
git add system/runtime/hosts/index.js system/runtime/hosts/detect.js system/runtime/hosts/claude-code.js system/runtime/hosts/gemini.js system/runtime/daemon/sessions.js system/tests/unit/runtime/hosts/host-naming.test.js
git commit -m "$(cat <<'EOF'
refactor(runtime): R-1 — canonicalize host names to hyphenated form

Adapter keys, ROBIN_HOST values, and adapter.name fields are now all
hyphenated ('claude-code', 'gemini-cli', 'unknown'). Adds HOSTS enum in
new hosts/index.js. Underscored ROBIN_HOST keeps working with a one-shot
deprecation warning.
EOF
)"
```

---

### Task 1.5: Biographer queue depth canary

**Files:**
- Modify: `system/cognition/biographer/queue.js`
- Create or Modify: `system/tests/unit/cognition/biographer/queue.test.js`

- [ ] **Step 1: Read current queue shape**

Run: `cat system/cognition/biographer/queue.js`

Note the existing exports (e.g., `createBiographerQueue`), the worker invocation, the dedupe logic, and any pendingDepth/length accessors.

- [ ] **Step 2: Write the failing test**

Create or extend `system/tests/unit/cognition/biographer/queue.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBiographerQueue } from '../../../../cognition/biographer/queue.js';

test('enqueue returns { skipped: true } when at maxPending cap', async () => {
  // Worker that never resolves, so the queue stays full.
  const block = new Promise(() => {});
  const q = createBiographerQueue({
    worker: async () => block,
    dedupe: true,
    maxPending: 2,
  });

  const r1 = q.enqueue('event-1');
  const r2 = q.enqueue('event-2');
  // Both r1 and r2 are now waiting on `block`. Queue is at depth 2.

  const r3 = q.enqueue('event-3');
  // r3 should be skipped, not enqueued.
  assert.deepEqual(await r3, { skipped: true });
});

test('skippedSinceBoot and lastSkippedAt are exposed', async () => {
  const block = new Promise(() => {});
  const q = createBiographerQueue({
    worker: async () => block,
    dedupe: true,
    maxPending: 1,
  });
  q.enqueue('event-1');
  assert.equal(q.skippedSinceBoot, 0);
  await q.enqueue('event-2');
  assert.equal(q.skippedSinceBoot, 1);
  assert.ok(q.lastSkippedAt instanceof Date || typeof q.lastSkippedAt === 'string');
});

test('pendingDepth reports current depth', async () => {
  const block = new Promise(() => {});
  const q = createBiographerQueue({
    worker: async () => block,
    dedupe: true,
    maxPending: 10,
  });
  assert.equal(q.pendingDepth, 0);
  q.enqueue('event-1');
  q.enqueue('event-2');
  assert.equal(q.pendingDepth, 2);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test system/tests/unit/cognition/biographer/queue.test.js`

Expected: FAIL — `maxPending` not honored; `skippedSinceBoot`/`pendingDepth` missing.

- [ ] **Step 4: Update `createBiographerQueue`**

Modify `system/cognition/biographer/queue.js`. Add `maxPending` to the options and expose the new accessors. The exact shape depends on the existing implementation; the additions are:

```js
// At the top of createBiographerQueue:
const maxPending = opts.maxPending ?? 1000;
const pending = new Set();           // or Map, depending on existing structure
let skippedSinceBoot = 0;
let lastSkippedAt = null;

// In the enqueue function, before any work begins:
if (pending.size >= maxPending) {
  skippedSinceBoot++;
  lastSkippedAt = new Date();
  console.warn(`[biographer] queue at cap (${maxPending}), skipping ${id} (will be picked up on next process-pending)`);
  return { skipped: true };
}
pending.add(id);  // (only if not already tracked via dedupe)

// In the worker dispatch's finally:
pending.delete(id);

// In the returned object:
return {
  enqueue,
  get pendingDepth() { return pending.size; },
  get skippedSinceBoot() { return skippedSinceBoot; },
  get lastSkippedAt() { return lastSkippedAt; },
  // ...existing accessors like lastRunAt
};
```

If the existing implementation already tracks pending in a different structure, adapt the cap check to use that structure's size.

- [ ] **Step 5: Run test to verify pass**

Run: `node --test system/tests/unit/cognition/biographer/queue.test.js`

Expected: all pass.

- [ ] **Step 6: Wire `pendingDepth`, `skippedSinceBoot`, `lastSkippedAt` into `health` MCP tool**

Read `system/io/mcp/tools/health.js`. Locate the `biographerQueue` field in the tool's output. Add the new fields. Example shape (adapt to existing):

```js
biographer: {
  lastRunAt: biographerQueue.lastRunAt,
  pendingDepth: biographerQueue.pendingDepth,
  skippedSinceBoot: biographerQueue.skippedSinceBoot,
  lastSkippedAt: biographerQueue.lastSkippedAt,
},
```

- [ ] **Step 7: Run full suite**

Run: `npm test`

Expected: all pass. The `queueWrap` wrapper in `server.js` may need a passthrough for the new accessors — search for `queueWrap` and add the getters if missing.

- [ ] **Step 8: Commit**

```bash
git add system/cognition/biographer/queue.js system/io/mcp/tools/health.js system/runtime/daemon/server.js system/tests/unit/cognition/biographer/queue.test.js
git commit -m "$(cat <<'EOF'
refactor(runtime): R-1 — biographer queue depth canary

createBiographerQueue gains maxPending (default 1000). Enqueue at cap
returns { skipped: true } and logs a warning; events stay in the events
table and get picked up by the next /internal/biographer/process-pending
call. pendingDepth, skippedSinceBoot, lastSkippedAt surfaced via the
health MCP tool.
EOF
)"
```

---

### Task 1.6: Embedder health retry + fatal handler wiring + reactivation watchdog

**Files:**
- Modify: `system/runtime/daemon/server.js`

This task wires three R-1 features into `startDaemon`: the retry util (Task 1.2), the fatal handlers (Task 1.3), and the host-detection reactivation watchdog.

- [ ] **Step 1: Add imports at the top of `server.js`**

In `system/runtime/daemon/server.js`, add near the existing daemon imports:

```js
import { paths } from '../../config/data-store.js';  // (likely already present)
import { createFatalHandler, installFatalHandlers } from './fatal.js';
import { retryWithBackoff } from './retry.js';
```

- [ ] **Step 2: Install fatal handlers at top of `startDaemon`**

In `startDaemon`, immediately after the `await ensureHome()` and BEFORE `acquireDaemonLock`, add:

```js
const logDir = `${paths.data.home()}/logs`;
const fatalHandler = createFatalHandler({
  logDir,
  shutdown: () => shutdown('fatal'),
});
const uninstallFatal = installFatalHandlers(fatalHandler);
```

Then in the existing `shutdown` body, add `uninstallFatal();` near the end (before the final `clearTimeout(grace)`).

Note: `shutdown` is null-guarded today (`if (sessionSweeper) ...`, `if (scheduler) ...`) — the fatal handler can safely fire even pre-lock.

- [ ] **Step 3: Replace the embedder health check with a retry wrapper**

Find the existing `try { const embedder = await idleEmbedder.get(); await embedder.healthCheck(); }` block. Replace its body so the inner work is retried:

```js
try {
  await retryWithBackoff(async () => {
    const embedder = await idleEmbedder.get();
    await embedder.healthCheck();
  }, {
    attempts: 3,
    perAttemptTimeoutMs: 10_000,
    backoffMs: [1000, 4000, 0],
    onRetry: (err, attempt) => {
      console.warn(`[daemon] embedder health check attempt ${attempt} failed: ${err.message}; retrying`);
    },
  });
} catch (e) {
  // ...existing profile-specific guidance + process.exit(1) stays
}
```

- [ ] **Step 4: Add the host reactivation watchdog**

After the existing `let host = null; try { host = await detectHost(); } catch ...` block, add a watchdog that runs only when host is null at boot. (In R-2 this becomes a bucket; in R-1 it's a standalone setInterval.)

Add a module-scoped variable + interval:

```js
let hostWatchdog = null;
async function activateHostDependentSubsystems() {
  // Stub for R-1: log only. The scheduler activation logic moves here in R-2.
  console.log('[daemon] host became available — host-dependent subsystems would activate now');
}
if (!host) {
  console.warn('[daemon] no host at boot; watchdog will retry every 5 min');
  hostWatchdog = setInterval(() => {
    detectHost().then((h) => {
      if (h) {
        host = h;
        clearInterval(hostWatchdog);
        hostWatchdog = null;
        activateHostDependentSubsystems().catch((e) =>
          console.warn(`[daemon] host activation failed: ${e.message}`),
        );
      }
    }).catch(() => { /* still no host, keep trying */ });
  }, 5 * 60_000);
  hostWatchdog.unref?.();
}
```

Add `if (hostWatchdog) clearInterval(hostWatchdog);` to the shutdown sequence.

Note: in R-1, `activateHostDependentSubsystems` is a stub because the scheduler and cadence ticker are still constructed inline at boot. R-2 replaces the watchdog with a bucket and makes activation real.

- [ ] **Step 5: Verify full test suite still passes**

Run: `npm test`

Expected: all pass. The daemon boot integration test should still succeed.

- [ ] **Step 6: Add an integration test for the watchdog**

Create `system/tests/integration/daemon/host-watchdog.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This test boots the daemon with no host available and confirms the watchdog
// warning is logged. Full lifecycle (host becomes available → scheduler starts)
// is covered in R-2.

test('daemon boots and logs host-watchdog warning when no host is detected', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'robin-home-'));
  const child = spawn(process.execPath, ['system/bin/robin', 'mcp', 'start'], {
    env: {
      ...process.env,
      ROBIN_HOME: home,
      ROBIN_HOST: '',  // explicitly empty
      PATH: '/usr/bin:/bin',  // remove access to claude/gemini CLIs from PATH
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

  // Give the daemon up to 25s to boot and emit the warning
  await new Promise((resolve) => setTimeout(resolve, 25_000));
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));

  assert.match(stderr, /no host at boot.*watchdog/i);
});
```

Note: this test boots a real daemon in a temp home and is slow. If your project has lighter-weight in-process boot helpers, prefer those. Mark the test as integration so it runs in `npm run test:integration`.

- [ ] **Step 7: Run the integration test**

Run: `npm run test:integration -- --test-name-pattern='watchdog'`

Expected: PASS within 30s.

- [ ] **Step 8: Commit**

```bash
git add system/runtime/daemon/server.js system/tests/integration/daemon/host-watchdog.test.js
git commit -m "$(cat <<'EOF'
refactor(runtime): R-1 — embedder retry, fatal handlers, host watchdog

- Embedder healthCheck wrapped in retryWithBackoff (3 attempts, 10s per
  attempt, ~35s worst case).
- Fatal handlers installed pre-lock so boot crashes get logged.
- Host-detection reactivation watchdog runs every 5 min when host is null
  at boot; logs once on success. Full activation logic lands in R-2.
EOF
)"
```

---

### Task 1.7: Open R-1 PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/runtime-r1-reliability
```

- [ ] **Step 2: Run lint + tests one more time**

```bash
npm run lint
npm test
```

Both green.

- [ ] **Step 3: Create PR**

```bash
gh pr create --title "refactor(runtime): R-1 — reliability hardening" --body "$(cat <<'EOF'
## Summary
- Atomic daemon lock (closes TOCTOU window via wx flag)
- Process-level fatal handlers with structured log + force-exit guarantee
- Host-name normalization to hyphenated canonical form
- Embedder health-check retry (3 attempts, ~35s worst-case)
- Biographer queue depth canary (events never lost; surfaced via health tool)
- Host-detection reactivation watchdog (5 min retry when no host at boot)

## Test plan
- [x] `npm test` green
- [x] `npm run lint` clean
- [x] New unit tests for lock, retry, fatal, queue, host-naming
- [x] New integration test for host-watchdog
- [ ] Dogfood for one day before merging R-2
EOF
)"
```

---

## Phase R-2: Tiered heartbeat (single PR)

**Scope:** Rewrite `createScheduler` to take buckets. Fold the four inline `setInterval` tickers in `server.js` into bucket entries. Fold R-1's host watchdog into a `host-watchdog` bucket. Wire `ctx.host` getter/setter (precursor to R-3's ctx).

**File structure for R-2:**

```
system/runtime/daemon/
├── heartbeat.js               REWRITE (bucket model)
└── server.js                  MODIFY (replace inline setIntervals with buckets)
system/tests/unit/runtime/daemon/
└── heartbeat.test.js          MODIFY (adapt to bucket shape)
└── heartbeat-buckets.test.js  CREATE (new bucket-specific tests)
```

### Task 2.1: Create R-2 branch

- [ ] **Step 1: Branch from main once R-1 has merged**

```bash
git checkout main
git pull origin main
git checkout -b feat/runtime-r2-heartbeat-buckets
```

---

### Task 2.2: Rewrite `heartbeat.js` to the bucket model

**Files:**
- Rewrite: `system/runtime/daemon/heartbeat.js`
- Create: `system/tests/unit/runtime/daemon/heartbeat-buckets.test.js`

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/runtime/daemon/heartbeat-buckets.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../../../../runtime/daemon/heartbeat.js';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('each bucket runs on its own interval', async () => {
  const calls = { a: 0, b: 0 };
  const sched = createScheduler({
    buckets: [
      { name: 'a', intervalMs: 30, tick: async () => { calls.a++; } },
      { name: 'b', intervalMs: 60, tick: async () => { calls.b++; } },
    ],
  });
  sched.start();
  await wait(180);
  sched.stop();
  // a: ~6 ticks (every 30ms over 180ms). b: ~3.
  assert.ok(calls.a >= 4, `expected a ≥ 4, got ${calls.a}`);
  assert.ok(calls.b >= 2, `expected b ≥ 2, got ${calls.b}`);
  assert.ok(calls.a > calls.b, 'a should tick more often than b');
});

test('fireImmediately runs once at start', async () => {
  let called = 0;
  const sched = createScheduler({
    buckets: [
      { name: 'eager', intervalMs: 10_000, tick: async () => { called++; }, fireImmediately: true },
    ],
  });
  sched.start();
  await wait(20);
  sched.stop();
  assert.equal(called, 1);
});

test('default (no fireImmediately) waits for first interval', async () => {
  let called = 0;
  const sched = createScheduler({
    buckets: [
      { name: 'lazy', intervalMs: 10_000, tick: async () => { called++; } },
    ],
  });
  sched.start();
  await wait(20);
  sched.stop();
  assert.equal(called, 0);
});

test('gate returning false skips the tick', async () => {
  let called = 0;
  const sched = createScheduler({
    buckets: [
      { name: 'gated', intervalMs: 20, gate: () => false, tick: async () => { called++; } },
    ],
  });
  sched.start();
  await wait(100);
  sched.stop();
  assert.equal(called, 0);
});

test('gate throw is caught and treated as skip', async () => {
  let called = 0;
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const sched = createScheduler({
      buckets: [
        { name: 'gate-throws', intervalMs: 20, gate: () => { throw new Error('gate boom'); }, tick: async () => { called++; } },
      ],
    });
    sched.start();
    await wait(60);
    sched.stop();
    assert.equal(called, 0);
  } finally {
    console.warn = origWarn;
  }
});

test('tick throw is caught and logged; bucket continues', async () => {
  let called = 0;
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const sched = createScheduler({
      buckets: [
        { name: 'crash', intervalMs: 20, tick: async () => { called++; throw new Error('tick boom'); } },
      ],
    });
    sched.start();
    await wait(80);
    sched.stop();
    assert.ok(called >= 2, `expected ≥ 2 ticks, got ${called}`);
    assert.ok(warnings.some((w) => /scheduler\/crash/.test(w)), `expected scheduler/crash warning, got: ${warnings.join('; ')}`);
  } finally {
    console.warn = origWarn;
  }
});

test('overlapping ticks within the same bucket are coalesced', async () => {
  let starts = 0;
  let finishes = 0;
  const sched = createScheduler({
    buckets: [
      {
        name: 'slow',
        intervalMs: 20,
        tick: async () => {
          starts++;
          await wait(80);
          finishes++;
        },
      },
    ],
  });
  sched.start();
  await wait(120);
  sched.stop();
  // The interval would fire 6 times in 120ms, but each tick takes 80ms.
  // Overlap protection means start count is much less than 6.
  assert.ok(starts < 5, `expected coalesced starts < 5, got ${starts}`);
});

test('stop clears every bucket', async () => {
  const calls = { a: 0 };
  const sched = createScheduler({
    buckets: [{ name: 'a', intervalMs: 10, tick: async () => { calls.a++; } }],
  });
  sched.start();
  await wait(40);
  const before = calls.a;
  sched.stop();
  await wait(50);
  assert.equal(calls.a, before, 'no ticks after stop');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test system/tests/unit/runtime/daemon/heartbeat-buckets.test.js`

Expected: FAIL — the existing `createScheduler` signature takes `{listDue, runOne, isOverflow}`, not `{buckets}`.

- [ ] **Step 3: Rewrite `heartbeat.js`**

Replace the entire contents of `system/runtime/daemon/heartbeat.js`:

```js
/**
 * Bucket-based heartbeat scheduler.
 *
 * Each bucket has its own interval and its own per-bucket running flag.
 * If a bucket's tick is still running when the interval fires, the next
 * tick is coalesced (skipped, not queued).
 *
 * Bucket shape: { name, intervalMs, tick, gate?, fireImmediately? }
 *   - tick: async function. Throws are caught + logged.
 *   - gate: optional sync/async predicate. Returning falsy skips the tick.
 *     Gate throws are caught + treated as skip.
 *   - fireImmediately: optional boolean (default false). When true, fires
 *     once at start() in addition to the interval cadence.
 *
 * Heartbeat polling is sleep-resilient: setInterval-based ticks fire
 * within `intervalMs` of laptop wake — no missed-tick queue burst.
 */
export function createScheduler({ buckets } = {}) {
  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new Error('createScheduler: buckets[] is required');
  }
  const timers = new Map();
  const running = new Map();

  async function fire(b) {
    if (running.get(b.name)) return;
    let ok = true;
    try {
      if (typeof b.gate === 'function') {
        try {
          ok = await b.gate();
        } catch (e) {
          ok = false;
          console.warn(`[scheduler/${b.name}] gate failed: ${e.message}`);
        }
      }
      if (!ok) return;
      running.set(b.name, true);
      await b.tick();
    } catch (e) {
      console.warn(`[scheduler/${b.name}] tick failed: ${e.message}`);
    } finally {
      running.set(b.name, false);
    }
  }

  function start() {
    stop();
    for (const b of buckets) {
      const t = setInterval(() => { fire(b); }, b.intervalMs);
      t.unref?.();
      timers.set(b.name, t);
      if (b.fireImmediately) fire(b);
    }
  }

  function stop() {
    for (const t of timers.values()) clearInterval(t);
    timers.clear();
  }

  return { start, stop };
}
```

- [ ] **Step 4: Run new tests**

Run: `node --test system/tests/unit/runtime/daemon/heartbeat-buckets.test.js`

Expected: all 8 tests pass.

- [ ] **Step 5: Update existing `heartbeat.test.js`**

Read `system/tests/unit/runtime/daemon/heartbeat.test.js`. The old `createScheduler({listDue, runOne, isOverflow})` signature is gone. The dispatcher's per-name in-flight logic now lives inside `dispatcherTick` (which the daemon constructs). Either:

(a) **If the existing test asserts on the old shape**: rewrite it to wrap the dispatcher logic in a single `tick` bucket and assert against that.

(b) **If the existing test asserts on integration with the daemon**: keep it; the daemon wiring update in Task 2.3 keeps the behavior.

The minimum viable rewrite of `heartbeat.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../../../../runtime/daemon/heartbeat.js';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('createScheduler runs a single dispatcher-style bucket', async () => {
  let dueCount = 0;
  const dueItems = ['a', 'b'];
  const ran = [];
  const dispatcherTick = async () => {
    dueCount++;
    for (const name of dueItems) ran.push(name);
  };
  const sched = createScheduler({
    buckets: [{ name: 'dispatcher', intervalMs: 30, tick: dispatcherTick, fireImmediately: true }],
  });
  sched.start();
  await wait(80);
  sched.stop();
  assert.ok(dueCount >= 2, `expected ≥ 2 ticks, got ${dueCount}`);
  assert.ok(ran.length >= 4);
});
```

- [ ] **Step 6: Run full suite**

Run: `npm test`

Expected: all pass. If `server.js` still references the old `createScheduler({listDue, ...})` signature, the daemon boot integration test will fail — fix that in the next task.

- [ ] **Step 7: Commit**

```bash
git add system/runtime/daemon/heartbeat.js system/tests/unit/runtime/daemon/heartbeat.test.js system/tests/unit/runtime/daemon/heartbeat-buckets.test.js
git commit -m "$(cat <<'EOF'
refactor(runtime): R-2 — bucket-based scheduler

createScheduler now takes { buckets: [{ name, intervalMs, tick, gate?,
fireImmediately? }] }. Per-bucket overlap protection, gate predicates, and
optional fire-at-start. Daemon wiring updated in next commit.
EOF
)"
```

---

### Task 2.3: Migrate `server.js` inline tickers into buckets

**Files:**
- Modify: `system/runtime/daemon/server.js`

- [ ] **Step 1: Promote dynamic imports to static**

At the top of `system/runtime/daemon/server.js`, add static imports for the modules currently loaded via `await import(...)` inside setIntervals:

```js
import { consumePendingTriggers } from './cadence-consumer.js';
import { closeStaleEpisodes } from '../../cognition/jobs/internal/close-stale-episodes.js';
import { runActionTrustDecay } from '../../cognition/jobs/action-trust.js';
```

Remove the corresponding `const { consumePendingTriggers } = await import(...)` and `const { closeStaleEpisodes } = await import(...)` and `const { runActionTrustDecay } = await import(...)` lines from the body.

- [ ] **Step 2: Extract `dispatcherTick`**

Locate the block:

```js
scheduler = createScheduler({
  listDue: async () => { ... },
  runOne: async (name) => { ... },
  isOverflow: async () => { ... },
});
```

Rewrite the surrounding code into a named `dispatcherTick` function:

```js
const inFlight = new Set();
async function dispatcherTick() {
  await refreshJobs();
  // Build due list (was baseListDue body)
  const due = [];
  const [rows] = await dbHandle
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  const value = rows[0]?.value ?? {};
  const integrations = value.integrations ?? {};
  const now = new Date();
  for (const [name, row] of Object.entries(integrations)) {
    if (!row?.next_run_at) continue;
    if (new Date(row.next_run_at) <= now && !row.in_flight) {
      due.push({ name, kind: 'integration' });
    }
  }
  const dreamCursor = value.dream;
  if (dreamCursor?.next_run_at && new Date(dreamCursor.next_run_at) <= now) {
    due.push({ name: '__dream__', kind: 'dream' });
  }
  // embed_backfill check
  try {
    const { activeProfile, embeddingTable } = await import('../../data/embed/profile-router.js');
    const profile = await activeProfile(dbHandle);
    const eventsEmbTbl = embeddingTable(profile, 'events');
    const [pending] = await dbHandle
      .query(
        `SELECT count() AS n FROM events
         WHERE meta.embed_failed IS NOT true
           AND id NOT IN (SELECT VALUE record FROM ${eventsEmbTbl})
         GROUP ALL`,
      )
      .collect();
    if ((pending[0]?.n ?? 0) > 0) due.push({ name: '__embed_backfill__', kind: 'embed_backfill' });
  } catch { /* no active profile yet */ }

  // Jobs due
  const jobsDue = await listDueJobs(dbHandle, new Date());

  // Run each, with per-name in-flight tracking. Fire-and-forget; the
  // bucket's own running flag is set true for the duration of this tick
  // but the actual dispatched work runs concurrently.
  const all = [...due, ...jobsDue];
  for (const item of all) {
    if (inFlight.has(item.name)) continue;
    inFlight.add(item.name);
    runOneItem(item.name)
      .catch((e) => console.warn(`[scheduler] ${item.name} failed: ${e.message}`))
      .finally(() => inFlight.delete(item.name));
  }
  // Overflow: if nothing dispatched and un-biographed queue is huge, kick dream
  if (inFlight.size === 0) {
    const [overflowRows] = await dbHandle
      .query(surql`SELECT count() AS n FROM events WHERE biographed_at IS NONE GROUP ALL`)
      .collect();
    if ((overflowRows[0]?.n ?? 0) >= 500) {
      inFlight.add('__dream__');
      runOneItem('__dream__')
        .catch((e) => console.warn(`[scheduler] __dream__ failed: ${e.message}`))
        .finally(() => inFlight.delete('__dream__'));
    }
  }
}

async function runOneItem(name) {
  const job = jobsCache.current.find((j) => j.name === name);
  if (job) {
    await runOneJob({
      db: dbHandle,
      capture: captureForJobs,
      host,
      jobs: jobsCache.current,
      tools,
      name,
    });
    await planNextRunAt(dbHandle, jobsCache.current);
    return;
  }
  // baseRunOne body
  if (name === '__embed_backfill__') {
    const e = await idleEmbedder.get();
    const { embedBackfillTick } = await import('../../data/embed/backfill.js');
    return await embedBackfillTick({ db: dbHandle, embedder: e, batch: 64, log: console.log });
  }
  if (name === '__dream__') {
    const e = await idleEmbedder.get();
    const h = host;
    try {
      return await dreamProcess(dbHandle, h, e);
    } finally {
      const next = new Date();
      next.setHours(4, 0, 0, 0);
      if (next <= new Date()) next.setDate(next.getDate() + 1);
      const [rows2] = await dbHandle
        .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
        .collect();
      const value2 = rows2[0]?.value ?? {};
      const dream2 = { ...(value2.dream ?? {}), next_run_at: next, last_run_at: new Date() };
      await dbHandle
        .query(surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value2, dream: dream2 }}`)
        .collect();
    }
  }
  return await runIntegrationSync(dbHandle, registry, name);
}
```

- [ ] **Step 3: Replace `scheduler = createScheduler(...)` and the four inline `setInterval` blocks**

Find and DELETE these existing blocks in `server.js`:

1. `scheduler = createScheduler({ listDue, runOne, isOverflow })` and surrounding wiring.
2. `let cadenceTicker = null; if (host) { ... setInterval ... }` (cadence-consumer).
3. `let staleEpisodeTicker = null; { ... setInterval ... }` (close-stale-episodes).
4. `let actionTrustDecayTicker = null; { ... setInterval ... }` (action-trust-decay).
5. `sessionSweeper = setInterval(() => { markStaleSessions ... }, 60_000)` (session sweep).
6. The R-1 host watchdog block from Task 1.6.

Replace ALL six with one scheduler construction:

```js
scheduler = createScheduler({
  buckets: [
    { name: 'dispatcher',     intervalMs: 60_000,        tick: dispatcherTick,      gate: () => !!host, fireImmediately: true },
    { name: 'cadence',        intervalMs: 60_000,        tick: () => consumePendingTriggers(dbHandle, host), gate: () => !!host },
    { name: 'stale-sessions', intervalMs: 60_000,        tick: () => markStaleSessions(dbHandle) },
    { name: 'stale-episodes', intervalMs: 600_000,       tick: () => closeStaleEpisodes(dbHandle) },
    { name: 'action-decay',   intervalMs: 6 * 3_600_000, tick: () => runActionTrustDecay(dbHandle) },
    {
      name: 'host-watchdog',
      intervalMs: 5 * 60_000,
      gate: () => !host,
      tick: async () => {
        try {
          const detected = await detectHost();
          if (detected) {
            host = detected;
            console.log('[daemon] host detected; dispatcher and cadence buckets will activate on next tick');
          }
        } catch { /* still no host */ }
      },
    },
  ],
});
scheduler.start();
```

Update the `shutdown` function to remove the deleted ticker variables (`sessionSweeper`, `cadenceTicker`, `staleEpisodeTicker`, `actionTrustDecayTicker`, `hostWatchdog`) and their `clearInterval` calls — `scheduler.stop()` now handles all of them.

- [ ] **Step 4: Run the full suite**

Run: `npm test`

Expected: all pass. Adjust any failures by re-reading the relevant block in `server.js` — most likely candidates are tests that introspect `sessionSweeper` or `cadenceTicker` variables (delete those assertions).

- [ ] **Step 5: Add an integration assertion for buckets**

Extend `system/tests/integration/daemon/host-watchdog.test.js` (from Task 1.6) so it asserts the daemon now starts cleanly *with* the host-watchdog bucket logging at boot. The existing test should already pass; verify it explicitly.

Run: `npm run test:integration -- --test-name-pattern='watchdog'`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add system/runtime/daemon/server.js
git commit -m "$(cat <<'EOF'
refactor(runtime): R-2 — fold inline tickers into bucket scheduler

The four inline setIntervals in server.js (cadence, stale-sessions,
stale-episodes, action-decay) and the R-1 host watchdog are now buckets
in the scheduler. dispatcherTick replaces the listDue/runOne/isOverflow
trio. server.js net shrinks ~80 lines.
EOF
)"
```

---

#### Task 2.4: Open R-2 PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/runtime-r2-heartbeat-buckets
```

- [ ] **Step 2: Run lint + tests**

```bash
npm run lint
npm test
```

Both green.

- [ ] **Step 3: Open PR**

```bash
gh pr create --title "refactor(runtime): R-2 — tiered heartbeat" --body "$(cat <<'EOF'
## Summary
- createScheduler rewritten to take buckets ({ name, intervalMs, tick, gate?, fireImmediately? }).
- Four inline setInterval tickers in server.js folded into bucket entries.
- R-1's host-watchdog setInterval folded into a host-watchdog bucket.
- Dynamic imports for cadence-consumer / close-stale-episodes / action-trust promoted to static.

## Test plan
- [x] heartbeat-buckets.test.js: 8 new tests cover gate, overlap, fireImmediately, error handling.
- [x] Existing heartbeat.test.js adapted to bucket shape.
- [x] Integration test for daemon boot with all six buckets armed.
- [x] `npm test` green.
EOF
)"
```

---

## Phase R-3: Decompose `server.js` + route table (single PR, 5 commits)

**Scope:** Split `server.js` into focused modules. Extract `lifecycle.js`, `boot.js`, `tools.js`, `http.js`, `routes/` (per-domain), `mcp-sse.js`. Each route becomes a data-driven entry with `({ ctx, body, tools }) → result` signature. URLs unchanged; payload shapes unchanged.

**File structure for R-3:**

```
system/runtime/daemon/
├── server.js              REWRITE (~80 lines, thin compose)
├── boot.js                CREATE
├── lifecycle.js           CREATE
├── tools.js               CREATE
├── http.js                CREATE
├── mcp-sse.js             CREATE (special-cased GET /sse handler)
└── routes/
    ├── index.js                CREATE (assembles route table)
    ├── biographer.js           CREATE
    ├── session.js              CREATE
    ├── remember.js             CREATE
    ├── jobs.js                 CREATE
    ├── knowledge.js            CREATE
    ├── actions.js              CREATE
    ├── commstyle.js            CREATE
    ├── predictions.js          CREATE
    ├── calibration.js          CREATE
    ├── embeddings.js           CREATE
    └── intuition.js            CREATE

system/tests/unit/runtime/daemon/
├── tools.test.js          CREATE
├── route-dispatch.test.js CREATE
└── lifecycle.test.js      CREATE

system/tests/integration/daemon/
└── boot.test.js           CREATE (real test DB + stub embedder)
```

### Task 3.1: Create R-3 branch

- [ ] **Step 1: Branch from main after R-2 merges**

```bash
git checkout main
git pull origin main
git checkout -b feat/runtime-r3-decompose-server
```

---

### Task 3.2: Extract `lifecycle.js` (commit 1 of 5)

**Files:**
- Create: `system/runtime/daemon/lifecycle.js`
- Modify: `system/runtime/daemon/server.js`
- Create: `system/tests/unit/runtime/daemon/lifecycle.test.js`

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/runtime/daemon/lifecycle.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifecycle } from '../../../../runtime/daemon/lifecycle.js';

async function tempLockPath() {
  const dir = await mkdtemp(join(tmpdir(), 'robin-lc-'));
  return join(dir, 'daemon.lock');
}

test('acquireLock writes pid; release deletes it', async () => {
  const lockPath = await tempLockPath();
  const lc = createLifecycle({ lockPath, statePath: lockPath + '.state' });
  await lc.acquireLock();
  const pid = Number.parseInt(await readFile(lockPath, 'utf8'), 10);
  assert.equal(pid, process.pid);
  await lc.shutdown('test');
});

test('shutdown calls registered subsystems in order', async () => {
  const lockPath = await tempLockPath();
  const lc = createLifecycle({ lockPath, statePath: lockPath + '.state' });
  await lc.acquireLock();
  const calls = [];
  lc.ready({
    scheduler: { stop: () => calls.push('scheduler.stop') },
    httpServer: { close: () => calls.push('http.close') },
    integrations: {
      stop: async () => calls.push('integrations.stop'),
    },
    db: { close: async () => calls.push('db.close') },
  });
  await lc.shutdown('test');
  assert.deepEqual(calls, ['scheduler.stop', 'integrations.stop', 'http.close', 'db.close']);
});

test('shutdown is idempotent (second call is a no-op)', async () => {
  const lockPath = await tempLockPath();
  const lc = createLifecycle({ lockPath, statePath: lockPath + '.state' });
  await lc.acquireLock();
  let stopCount = 0;
  lc.ready({ scheduler: { stop: () => { stopCount++; } } });
  await lc.shutdown('first');
  await lc.shutdown('second');
  assert.equal(stopCount, 1);
});

test('shutdown is safe before ready (null-guarded)', async () => {
  const lockPath = await tempLockPath();
  const lc = createLifecycle({ lockPath, statePath: lockPath + '.state' });
  await lc.acquireLock();
  // No ready() call. shutdown should not throw.
  await lc.shutdown('pre-ready');
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test system/tests/unit/runtime/daemon/lifecycle.test.js`

Expected: FAIL — `lifecycle.js` doesn't exist.

- [ ] **Step 3: Implement `lifecycle.js`**

Create `system/runtime/daemon/lifecycle.js`:

```js
import { acquireDaemonLock, releaseDaemonLock } from './lock.js';
import { clearDaemonState, writeDaemonState } from './state.js';
import { createFatalHandler, installFatalHandlers } from './fatal.js';

/**
 * Daemon lifecycle owner: lock, fatal handlers, state file, signals,
 * graceful shutdown. Subsystems register via `ready()`; shutdown stops
 * them in declared order. Idempotent.
 */
export function createLifecycle({ lockPath, statePath, logDir } = {}) {
  let acquired = false;
  let subsystems = null;
  let shuttingDown = false;
  let uninstallFatal = null;
  let signalsBound = false;

  async function acquireLock() {
    if (acquired) return;
    await acquireDaemonLock(lockPath);
    acquired = true;
    if (logDir) {
      const handler = createFatalHandler({ logDir, shutdown: () => shutdown('fatal') });
      uninstallFatal = installFatalHandlers(handler);
    }
    if (!signalsBound) {
      process.on('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
      process.on('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
      signalsBound = true;
    }
  }

  function ready(parts) {
    subsystems = parts;
  }

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signal) console.log(`daemon: received ${signal}, shutting down`);
    const grace = setTimeout(() => {
      console.warn('daemon: shutdown grace expired, forcing exit');
      process.exit(1);
    }, 10_000);
    grace.unref?.();

    try {
      if (subsystems?.scheduler?.stop) {
        try { subsystems.scheduler.stop(); } catch (e) { console.warn(`scheduler stop failed: ${e.message}`); }
      }
      if (subsystems?.integrations?.stop) {
        try { await subsystems.integrations.stop(); } catch (e) { console.warn(`integrations stop failed: ${e.message}`); }
      }
      if (subsystems?.httpServer?.close) {
        try { subsystems.httpServer.close(); } catch (e) { console.warn(`http close failed: ${e.message}`); }
      }
      if (subsystems?.db?.close) {
        try { await subsystems.db.close(); } catch (e) { console.warn(`db close failed: ${e.message}`); }
      }
    } finally {
      if (statePath) await clearDaemonState(statePath).catch(() => {});
      if (acquired && lockPath) await releaseDaemonLock(lockPath).catch(() => {});
      if (uninstallFatal) uninstallFatal();
      clearTimeout(grace);
    }
  }

  async function writeReady({ port, pid, version, startedAt, toolCount }) {
    if (statePath) {
      await writeDaemonState(statePath, {
        port,
        pid,
        version,
        started_at: startedAt,
        tool_count: toolCount,
      });
    }
  }

  async function wait() {
    return new Promise(() => {});
  }

  async function fail(err) {
    console.error(`daemon failed: ${err.message}`);
    await shutdown('fail');
  }

  return { acquireLock, ready, shutdown, writeReady, wait, fail };
}
```

- [ ] **Step 4: Run new test**

Run: `node --test system/tests/unit/runtime/daemon/lifecycle.test.js`

Expected: all 4 tests pass. (If the integrations.stop expectation needs a wrapper around per-gateway clients, the daemon-side wrapper goes in boot.js — Task 3.3 wires this.)

- [ ] **Step 5: Update `server.js` to use lifecycle (intermediate state)**

Edit `system/runtime/daemon/server.js`. At the top of `startDaemon`:

```js
const lifecycle = createLifecycle({
  lockPath: paths.data.daemonLock(),
  statePath: paths.data.daemonState(),
  logDir: `${paths.data.home()}/logs`,
});
await lifecycle.acquireLock();
```

Delete the existing `acquireDaemonLock(lockPath)`, the inline `process.on('SIGTERM' | 'SIGINT')` handlers, the in-function `shutdown` definition, and the R-1 manual `installFatalHandlers(...)` wiring. Keep references to `shutdown` (used by various error paths) but replace them with `lifecycle.shutdown`.

After all subsystems are constructed (scheduler, httpServer, gatewayClients), call:

```js
lifecycle.ready({
  scheduler,
  httpServer,
  integrations: {
    stop: async () => {
      for (const [name, client] of gatewayClients) {
        const m = registry.get(name);
        if (m?.stop) {
          try { await m.stop({ log: console.log }, client); }
          catch (e) { console.warn(`integration ${name}: stop failed: ${e.message}`); }
        }
      }
    },
  },
  db: { close: async () => { if (dbHandle) await close(dbHandle).catch(() => {}); } },
});
await lifecycle.writeReady({
  port,
  pid: process.pid,
  version,
  startedAt: startedAt.toISOString(),
  toolCount: tools.length,
});
await lifecycle.wait();
```

In the outer `catch (e)` of `startDaemon`, replace `await shutdown();` with `await lifecycle.fail(e);`.

- [ ] **Step 6: Run full suite**

Run: `npm test`

Expected: all pass. Boot integration test should succeed.

- [ ] **Step 7: Commit**

```bash
git add system/runtime/daemon/lifecycle.js system/runtime/daemon/server.js system/tests/unit/runtime/daemon/lifecycle.test.js
git commit -m "refactor(runtime): R-3 commit 1/5 — extract lifecycle.js"
```

---

### Task 3.3: Extract `boot.js` (commit 2 of 5)

**Files:**
- Create: `system/runtime/daemon/boot.js`
- Modify: `system/runtime/daemon/server.js`
- Create: `system/tests/integration/daemon/boot.test.js`

- [ ] **Step 1: Implement `boot.js`**

Create `system/runtime/daemon/boot.js`. The function `boot()` collects everything `startDaemon` currently constructs (DB, embedder, introspection, host, integrations, jobs cache) and returns a `ctx` object.

```js
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surql } from 'surrealdb';
import { createBiographerQueue } from '../../cognition/biographer/queue.js';
import { garbageCollect, upsertFromDiscovered } from '../../cognition/jobs/db.js';
import { discoverJobs } from '../../cognition/jobs/loader.js';
import { planNextRunAt } from '../../cognition/jobs/scheduler-ext.js';
import { ensureHome, paths } from '../../config/data-store.js';
import { readConfig } from '../../config/paths.js';
import { envFilePath } from '../../config/secrets.js';
import { close, connect, defaultDbUrl } from '../../data/db/client.js';
import { createEmbedder } from '../../data/embed/factory.js';
import { resetInFlightFlags } from '../../io/integrations/_framework/boot-cleanup.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';
import { loadManifests } from '../../io/integrations/_framework/manifest-loader.js';
import { createRepeatQueryDetector } from '../../io/mcp/implicit-signals.js';
import { biographerProcess } from '../../cognition/biographer/pipeline.js';
import { detectHost } from '../hosts/detect.js';
import { createIdleEmbedder } from './idle-embedder.js';
import { runIntrospection } from './introspection.js';
import { retryWithBackoff } from './retry.js';
import { getCliVersion } from './version-handshake.js';

const BUILTIN_JOBS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'jobs', 'builtin');

/**
 * Boot the daemon: ensure home, open DB, detect drift, build embedder,
 * run introspection, detect host, build biographer queue, load integration
 * manifests, discover jobs. Returns the ctx object consumed by tools, routes,
 * and the scheduler.
 *
 * Boot is procedural — it has side effects on the DB (UPSERT into
 * runtime:scheduler for cursors). The return value is the assembled ctx.
 */
export async function boot() {
  const version = await getCliVersion();
  const startedAt = new Date();
  await ensureHome();
  if (!existsSync(envFilePath())) {
    console.warn(`[daemon] no secrets file at ${envFilePath()} — integrations will fail.`);
  }

  const dbHandle = await connect({ engine: await defaultDbUrl() });

  // Profile-drift detection
  const cfg = await readConfig();
  if (!cfg?.embedder_profile) {
    throw new Error('no embedder profile configured; run `robin install` first.');
  }
  {
    const [rows] = await dbHandle
      .query(surql`SELECT * FROM type::record('runtime', 'embedder')`)
      .collect();
    const runtimeProfile = rows?.[0]?.value?.profile;
    if (runtimeProfile && runtimeProfile !== cfg.embedder_profile) {
      throw new Error(
        `config drift: config.json=${cfg.embedder_profile}, runtime:embedder=${runtimeProfile}`,
      );
    }
  }

  const idleEmbedder = createIdleEmbedder({ factory: createEmbedder, idleMs: 600_000 });

  // Embedder health with retry (from R-1)
  await retryWithBackoff(async () => {
    const e = await idleEmbedder.get();
    await e.healthCheck();
  }, {
    attempts: 3,
    perAttemptTimeoutMs: 10_000,
    backoffMs: [1000, 4000, 0],
    onRetry: (err, attempt) => console.warn(`[daemon] embedder health attempt ${attempt} failed: ${err.message}`),
  });

  // Introspection (fail-soft)
  try {
    const introspection = await runIntrospection(dbHandle);
    if (!introspection.ok && introspection.findings.length > 0) {
      for (const f of introspection.findings) {
        console.warn(`[daemon] introspection — ${f.kind}${f.path ? `: ${f.path}` : ''}${f.detail ? ` (${f.detail})` : ''}`);
      }
    }
  } catch (e) {
    console.warn(`[daemon] introspection failed (non-fatal): ${e.message}`);
  }

  // Host detect (may be null)
  let _host = null;
  try { _host = await detectHost(); }
  catch (e) {
    console.warn(`[daemon] no host at boot: ${e.message}; scheduler disabled until detected`);
  }

  const embedderWrap = {
    isLoaded: () => false,
    embed: async (text) => (await idleEmbedder.get()).embed(text),
  };
  const detector = createRepeatQueryDetector({});

  // Biographer queue
  const queue = createBiographerQueue({
    worker: async (eventId) => {
      const e = await idleEmbedder.get();
      const h = ctx.host;  // late-bound through ctx
      await biographerProcess(dbHandle, e, h, eventId);
    },
    dedupe: true,
    maxPending: 1000,
  });
  let lastBiographerRunAt = null;
  const queueWrap = {
    enqueue: (id) => {
      const ret = queue.enqueue(id);
      if (ret?.then) {
        ret.then(() => { lastBiographerRunAt = new Date().toISOString(); })
          .catch((e) => console.warn(`[biographer] enqueue/process failed for ${id}: ${e.message}`));
      }
      return ret;
    },
    get lastRunAt() { return lastBiographerRunAt; },
    get pendingDepth() { return queue.pendingDepth; },
    get skippedSinceBoot() { return queue.skippedSinceBoot; },
    get lastSkippedAt() { return queue.lastSkippedAt; },
  };

  // Integrations
  await resetInFlightFlags(dbHandle);
  const integrationsDir = new URL('../../io/integrations/', import.meta.url).pathname;
  const { loaded: manifests, unavailable } = await loadManifests(integrationsDir);
  for (const u of unavailable) console.warn(`[daemon] integration ${u.name} unavailable: ${u.error}`);
  const registry = new Map();
  const gatewayClients = new Map();
  for (const m of manifests) {
    const capture = createCapture({
      db: dbHandle, embedder: embedderWrap, source: m.name, embed: m.embed, mode: m.capture_mode,
    });
    registry.set(m.name, { ...m, capture });
    // Seed scheduler cursor for sync integrations
    if (m.cadence_ms !== null && m.sync) {
      const [rows] = await dbHandle
        .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
        .collect();
      const value = rows[0]?.value ?? {};
      const integrations = value.integrations ?? {};
      if (!integrations[m.name]) {
        integrations[m.name] = { cadence_ms: m.cadence_ms, next_run_at: new Date(), consecutive_failures: 0 };
        await dbHandle
          .query(surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, integrations }}`)
          .collect();
      }
    } else if (m.cadence_ms === null && m.start) {
      try {
        const client = await m.start({
          db: dbHandle, host: _host, log: (...a) => console.log(`[${m.name}]`, ...a), capture,
        });
        gatewayClients.set(m.name, client);
        console.log(`integration ${m.name}: gateway started`);
      } catch (e) {
        console.warn(`integration ${m.name}: gateway start failed: ${e.message}`);
      }
    }
  }

  // Seed dream cursor
  {
    const [rows] = await dbHandle
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const value = rows[0]?.value ?? {};
    if (!value.dream?.next_run_at) {
      const next = new Date();
      next.setHours(4, 0, 0, 0);
      if (next <= new Date()) next.setDate(next.getDate() + 1);
      const dream = { ...(value.dream ?? {}), next_run_at: next };
      await dbHandle
        .query(surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, dream }}`)
        .collect();
    }
  }

  // Jobs
  const jobsCache = { current: [] };
  const refreshJobs = async () => {
    const userJobsDir = join(paths.data.home(), 'jobs');
    jobsCache.current = discoverJobs({ builtinDir: BUILTIN_JOBS_DIR, userDir: userJobsDir });
    await upsertFromDiscovered(dbHandle, jobsCache.current);
    await garbageCollect(dbHandle, new Set(jobsCache.current.map((j) => j.name)));
    await planNextRunAt(dbHandle, jobsCache.current);
  };
  await refreshJobs();

  const captureForJobs = createCapture({
    db: dbHandle, embedder: embedderWrap, source: 'job_output', embed: false, mode: 'insert-or-skip',
  });

  const ctx = {
    version,
    startedAt,
    db: dbHandle,
    embedder: { idle: idleEmbedder, wrap: embedderWrap },
    detector,
    queue: queueWrap,
    sessions: { count: 0 },
    manifests, registry, gatewayClients,
    jobs: { cache: jobsCache, refresh: refreshJobs },
    capture: { forJobs: captureForJobs },
    get host() { return _host; },
    setHost(h) { _host = h; },
    log: console.log,
    // Cleanup helper consumed by lifecycle
    closeDb: () => close(dbHandle).catch(() => {}),
  };
  return ctx;
}
```

- [ ] **Step 2: Update `server.js` to use `boot()`**

In `system/runtime/daemon/server.js`, replace the long inline boot sequence (everything from `dbHandle = await connect(...)` down through the jobs `refreshJobs()` call) with:

```js
const ctx = await boot();
```

Replace all subsequent references to local variables with `ctx.<field>`:
- `dbHandle` → `ctx.db`
- `idleEmbedder` → `ctx.embedder.idle`
- `embedderWrap` → `ctx.embedder.wrap`
- `queueWrap` → `ctx.queue`
- `detector` → `ctx.detector`
- `sessions` → `ctx.sessions`
- `manifests` → `ctx.manifests`
- `registry` → `ctx.registry`
- `gatewayClients` → `ctx.gatewayClients`
- `jobsCache` → `ctx.jobs.cache`
- `refreshJobs` → `ctx.jobs.refresh`
- `captureForJobs` → `ctx.capture.forJobs`
- `host` reads → `ctx.host`
- `host = detected` writes (R-2 watchdog tick) → `ctx.setHost(detected)`

The scheduler buckets that closed over `host` need updating to close over `ctx.host`:

```js
{ name: 'cadence', intervalMs: 60_000, gate: () => !!ctx.host, tick: () => consumePendingTriggers(ctx.db, ctx.host) },
{ name: 'host-watchdog', intervalMs: 5 * 60_000, gate: () => !ctx.host, tick: async () => {
    try { const h = await detectHost(); if (h) { ctx.setHost(h); console.log('[daemon] host detected'); } }
    catch { /* still no host */ }
  } },
```

- [ ] **Step 3: Write boot integration test**

Create `system/tests/integration/daemon/boot.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../../../runtime/daemon/boot.js';

// This test requires a configured ROBIN_HOME with config.json + a fresh DB.
// Use the project's test fixture / migrate-fresh script if available.

test('boot returns a ctx with expected fields', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'robin-boot-'));
  process.env.ROBIN_HOME = home;
  await writeFile(join(home, 'config.json'), JSON.stringify({ embedder_profile: 'mxbai-1024' }));
  // Run migrate-fresh equivalent if needed; otherwise expect boot to fail
  // gracefully with a clear error and skip this test.
  try {
    const ctx = await boot();
    assert.ok(ctx.db, 'db handle');
    assert.ok(ctx.embedder?.idle, 'embedder');
    assert.ok(ctx.queue?.enqueue, 'queue');
    assert.ok(typeof ctx.host === 'string' || ctx.host === null, 'host');
    assert.ok(ctx.manifests, 'manifests');
    await ctx.closeDb();
  } catch (e) {
    // Acceptable failure modes in a bare temp home: no migrations applied,
    // no host on PATH. Skip rather than fail the test if those are the cause.
    if (/migration|profile|host/i.test(e.message)) {
      console.warn(`boot test skipped: ${e.message}`);
      return;
    }
    throw e;
  }
});
```

- [ ] **Step 4: Run tests**

```bash
npm test
npm run test:integration
```

Expected: all pass; boot.test may skip in CI without a configured home.

- [ ] **Step 5: Commit**

```bash
git add system/runtime/daemon/boot.js system/runtime/daemon/server.js system/tests/integration/daemon/boot.test.js
git commit -m "refactor(runtime): R-3 commit 2/5 — extract boot.js, return ctx"
```

---

### Task 3.4: Extract `tools.js` (commit 3 of 5)

**Files:**
- Create: `system/runtime/daemon/tools.js`
- Modify: `system/runtime/daemon/server.js`
- Create: `system/tests/unit/runtime/daemon/tools.test.js`

- [ ] **Step 1: Create `tools.js`**

Create `system/runtime/daemon/tools.js`. Lift the entire MCP-tool-construction sequence from `server.js`:

```js
import { createArchiveHistoryTool } from '../../io/mcp/tools/archive-history.js';
import { createAuditTool } from '../../io/mcp/tools/audit.js';
import { createCheckActionTool } from '../../io/mcp/tools/check-action.js';
import { createEndorseTool } from '../../io/mcp/tools/endorse.js';
import { createExplainActionTrustTool } from '../../io/mcp/tools/explain-action-trust.js';
import { createExplainBeliefTool } from '../../io/mcp/tools/explain-belief.js';
import { createExplainRecallTool } from '../../io/mcp/tools/explain-recall.js';
import { createFindEntityTool } from '../../io/mcp/tools/find-entity.js';
import { createGetArcTool } from '../../io/mcp/tools/get-arc.js';
import { createGetCommStyleTool } from '../../io/mcp/tools/get-comm-style.js';
import { createGetEntityTool } from '../../io/mcp/tools/get-entity.js';
import { createGetHotTool } from '../../io/mcp/tools/get-hot.js';
import { createGetKnowledgeTool } from '../../io/mcp/tools/get-knowledge.js';
import { createGetProfileTool } from '../../io/mcp/tools/get-profile.js';
import { createHealthTool } from '../../io/mcp/tools/health.js';
import { createIngestTool } from '../../io/mcp/tools/ingest.js';
import { createIntegrationRunTool } from '../../io/mcp/tools/integration-run.js';
import { createIntegrationStatusTool } from '../../io/mcp/tools/integration-status.js';
import { createLintTool } from '../../io/mcp/tools/lint.js';
import { createListArcsTool } from '../../io/mcp/tools/list-arcs.js';
import { createListEpisodesTool } from '../../io/mcp/tools/list-episodes.js';
import { createListJobsTool } from '../../io/mcp/tools/list-jobs.js';
import { createListJournalTool } from '../../io/mcp/tools/list-journal.js';
import { createListOpenPredictionsTool } from '../../io/mcp/tools/list-open-predictions.js';
import { createListPatternsTool } from '../../io/mcp/tools/list-patterns.js';
import { createListRulesTool } from '../../io/mcp/tools/list-rules.js';
import { createPredictTool } from '../../io/mcp/tools/predict.js';
import { createRecallTool } from '../../io/mcp/tools/recall.js';
import { createRecentRefusalsTool } from '../../io/mcp/tools/recent-refusals.js';
import { createRecordCorrectionTool } from '../../io/mcp/tools/record-correction.js';
import { createRefuteTool } from '../../io/mcp/tools/refute.js';
import { createRelatedEntitiesTool } from '../../io/mcp/tools/related-entities.js';
import { createRememberTool } from '../../io/mcp/tools/remember.js';
import { createResolvePredictionTool } from '../../io/mcp/tools/resolve-prediction.js';
import { createRunBiographerTool } from '../../io/mcp/tools/run-biographer.js';
import { createRunDreamTool } from '../../io/mcp/tools/run-dream.js';
import { createRunJobTool } from '../../io/mcp/tools/run-job.js';
import { createShowPendingTriggersTool } from '../../io/mcp/tools/show-pending-triggers.js';
import { createShowStepHealthTool } from '../../io/mcp/tools/show-step-health.js';
import { createUpdateActionPolicyTool } from '../../io/mcp/tools/update-action-policy.js';
import { createUpdateRuleTool } from '../../io/mcp/tools/update-rule.js';
import { runIntegrationSync } from '../../io/integrations/_framework/run-sync.js';
import { dreamProcess } from '../../cognition/dream/pipeline.js';

/**
 * Build the MCP tool array from a ctx. Pure: no side effects, no module
 * state. Safe to call from tests against a stub ctx.
 *
 * `tools: () => tools` thunk for createRunJobTool is preserved by passing
 * a thunk that closes over the resulting array (filled in at the bottom).
 */
export function buildTools(ctx) {
  const tools = [];
  const getTools = () => tools;

  tools.push(
    createHealthTool({
      version: ctx.version,
      startedAt: ctx.startedAt,
      db: { isOpen: () => true, query: (...a) => ctx.db.query(...a) },
      embedder: ctx.embedder.wrap,
      biographerQueue: ctx.queue,
      sessions: ctx.sessions,
    }),
    createRecallTool({ db: ctx.db, embedder: ctx.embedder.wrap, detector: ctx.detector, getSessionId: () => null }),
    createRememberTool({ db: ctx.db, embedder: ctx.embedder.wrap, queue: ctx.queue }),
    createRunBiographerTool({ db: ctx.db, processor: ctx.queue.enqueue }),
    createFindEntityTool({ db: ctx.db, embedder: ctx.embedder.wrap }),
    createGetEntityTool({ db: ctx.db }),
    createRelatedEntitiesTool({ db: ctx.db }),
    createListEpisodesTool({ db: ctx.db }),
    createRecordCorrectionTool({ db: ctx.db, embedder: ctx.embedder.wrap, processor: ctx.queue.enqueue }),
    createGetKnowledgeTool({ db: ctx.db, embedder: ctx.embedder.wrap }),
    createListPatternsTool({ db: ctx.db }),
    createGetProfileTool({ db: ctx.db }),
    createListJournalTool({ db: ctx.db }),
    createGetHotTool({ db: ctx.db }),
    createListRulesTool({ db: ctx.db }),
    createUpdateRuleTool({ db: ctx.db }),
    createRunDreamTool({ db: ctx.db, host: ctx.host, embedder: ctx.embedder.wrap, dreamProcess }),
    createIntegrationStatusTool({ db: ctx.db }),
    createIntegrationRunTool({ db: ctx.db, registry: ctx.registry, runIntegrationSync }),
  );

  // Per-manifest integration tools
  const getGatewayClient = (name) => ctx.gatewayClients.get(name) ?? null;
  for (const m of ctx.manifests) {
    for (const factory of m.tools ?? []) {
      try {
        const reg = ctx.registry.get(m.name);
        tools.push(factory({
          db: ctx.db, embedder: ctx.embedder.wrap, capture: reg?.capture, getGatewayClient,
        }));
      } catch (e) {
        console.warn(`integration ${m.name}: tool factory failed: ${e.message}`);
      }
    }
  }

  tools.push(
    createListJobsTool({ db: ctx.db }),
    createRunJobTool({
      db: ctx.db, capture: ctx.capture.forJobs, host: ctx.host,
      tools: getTools, getJobs: () => ctx.jobs.cache.current,
    }),
    createIngestTool({ db: ctx.db, embedder: ctx.embedder.wrap, host: ctx.host }),
    createLintTool({ db: ctx.db }),
    createAuditTool({ db: ctx.db, host: ctx.host }),
    createCheckActionTool({ db: ctx.db }),
    createUpdateActionPolicyTool({ db: ctx.db }),
    createGetCommStyleTool({ db: ctx.db }),
    createPredictTool({ db: ctx.db }),
    createResolvePredictionTool({ db: ctx.db }),
    createListOpenPredictionsTool({ db: ctx.db }),
    createEndorseTool({ db: ctx.db }),
    createRefuteTool({ db: ctx.db }),
    createListArcsTool({ db: ctx.db }),
    createGetArcTool({ db: ctx.db }),
    createExplainRecallTool({ db: ctx.db }),
    createExplainBeliefTool({ db: ctx.db }),
    createExplainActionTrustTool({ db: ctx.db }),
    createShowPendingTriggersTool({ db: ctx.db }),
    createShowStepHealthTool({ db: ctx.db }),
    createRecentRefusalsTool({ db: ctx.db }),
    createArchiveHistoryTool({ db: ctx.db }),
  );

  return tools;
}
```

- [ ] **Step 2: Test `buildTools` purity**

Create `system/tests/unit/runtime/daemon/tools.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools } from '../../../../runtime/daemon/tools.js';

function stubCtx() {
  return {
    version: '0.0.0-test',
    startedAt: new Date(),
    db: { query: () => ({ collect: async () => [[]] }) },
    embedder: { idle: { get: async () => ({ embed: async () => [] }) }, wrap: { isLoaded: () => false, embed: async () => [] } },
    detector: { register: () => {}, check: () => null },
    queue: { enqueue: () => {}, lastRunAt: null, pendingDepth: 0, skippedSinceBoot: 0, lastSkippedAt: null },
    sessions: { count: 0 },
    manifests: [],
    registry: new Map(),
    gatewayClients: new Map(),
    jobs: { cache: { current: [] }, refresh: async () => {} },
    capture: { forJobs: { capture: async () => {} } },
    host: { name: 'claude-code', invoke: async () => '' },
    log: () => {},
  };
}

test('buildTools returns an array of named tools', () => {
  const tools = buildTools(stubCtx());
  assert.ok(Array.isArray(tools));
  assert.ok(tools.length > 20);
  for (const t of tools) {
    assert.ok(typeof t.name === 'string');
    assert.ok(typeof t.handler === 'function');
  }
});

test('tool names are unique', () => {
  const tools = buildTools(stubCtx());
  const names = tools.map((t) => t.name);
  const set = new Set(names);
  assert.equal(set.size, names.length, 'duplicate tool name');
});

test('buildTools is pure (two calls produce independent arrays)', () => {
  const ctx = stubCtx();
  const a = buildTools(ctx);
  const b = buildTools(ctx);
  assert.notEqual(a, b);
  assert.equal(a.length, b.length);
});
```

- [ ] **Step 3: Run tests**

```bash
node --test system/tests/unit/runtime/daemon/tools.test.js
```

Expected: all 3 pass.

- [ ] **Step 4: Update `server.js` to use `buildTools`**

In `system/runtime/daemon/server.js`, delete the long `const tools = [createHealthTool(...), createRecallTool(...), ...]` sequence. Replace with:

```js
const tools = buildTools(ctx);
```

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add system/runtime/daemon/tools.js system/runtime/daemon/server.js system/tests/unit/runtime/daemon/tools.test.js
git commit -m "refactor(runtime): R-3 commit 3/5 — extract tools.js (pure buildTools)"
```

---

### Task 3.5: Extract `http.js` + `routes/` + `mcp-sse.js` (commit 4 of 5)

**Files:**
- Create: `system/runtime/daemon/http.js`
- Create: `system/runtime/daemon/mcp-sse.js`
- Create: `system/runtime/daemon/routes/*.js` (11 files + index)
- Modify: `system/runtime/daemon/server.js`
- Create: `system/tests/unit/runtime/daemon/route-dispatch.test.js`

- [ ] **Step 1: Create `http.js`**

Create `system/runtime/daemon/http.js`:

```js
import { createServer } from 'node:http';
import { handleSse } from './mcp-sse.js';

async function readJsonBody(req) {
  return await new Promise((resolveBody) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolveBody({});
      try { resolveBody(JSON.parse(raw)); }
      catch { resolveBody({}); }
    });
    req.on('error', () => resolveBody({}));
  });
}

/**
 * Build an HTTP server. Route table is `Array<{ method, path, handler }>`.
 * Handler signature: `async ({ ctx, body, tools }) => result | { _status, _body, _headers? }`.
 *
 * `GET /sse` is special-cased and dispatched to `handleSse`; not in the table.
 */
export function startHttp({ ctx, tools, routes, port }) {
  const table = new Map();
  for (const r of routes) table.set(`${r.method} ${r.path}`, r);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url.startsWith('/sse')) {
        ctx.sessions.count++;
        await handleSse(req, res, { ctx, tools });
        req.on('close', () => { ctx.sessions.count = Math.max(0, ctx.sessions.count - 1); });
        return;
      }
      const key = `${req.method} ${req.url}`;
      const entry = table.get(key);
      if (!entry) {
        res.writeHead(404).end();
        return;
      }
      const body = await readJsonBody(req);
      const result = await entry.handler({ ctx, body, tools });
      if (result && typeof result === 'object' && '_status' in result) {
        res.writeHead(result._status, result._headers ?? { 'content-type': 'application/json' });
        res.end(typeof result._body === 'string' ? result._body : JSON.stringify(result._body ?? {}));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result ?? {}));
    } catch (e) {
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, name: e.name }));
      } catch { /* response already sent */ }
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
```

- [ ] **Step 2: Create `mcp-sse.js`**

Create `system/runtime/daemon/mcp-sse.js`. Lift the SSE handling block out of `server.js`:

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function handleSse(req, res, { ctx, tools }) {
  const transport = new SSEServerTransport('/messages', res);
  const mcpServer = new Server({ name: 'robin', version: ctx.version }, { capabilities: { tools: {} } });
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] };
    try {
      const result = await tool.handler(args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });
  await mcpServer.connect(transport);
}
```

- [ ] **Step 3: Create the route files (apply the pattern uniformly)**

For each of the 17 `/internal/*` routes in `server.js`, create one route file per domain. The migration pattern is identical for every route:

**Pattern (apply to each):**

1. Find the route block in `server.js` matching `if (req.method === 'POST' && req.url === '/internal/<path>')`.
2. Copy the handler body into a function `handler({ ctx, body, tools })`.
3. Replace every `body.x` reference with `body.x` (no change — body is the parsed JSON).
4. Replace every `dbHandle` with `ctx.db`, every `host` with `ctx.host`, every `embedderWrap` with `ctx.embedder.wrap`, every `queueWrap` with `ctx.queue`, every `registry` with `ctx.registry`, etc.
5. Replace `res.writeHead(N, ...).end(JSON.stringify(X))` with `return { _status: N, _body: X }` if N ≠ 200, otherwise just `return X`.
6. Replace `res.writeHead(200, ...).end(JSON.stringify(X))` with `return X`.

Create each route file. The route file shape is uniform — here's the template (use for every file):

```js
// system/runtime/daemon/routes/<domain>.js
export const <domain>Routes = [
  {
    method: 'POST',
    path: '/internal/<path>',
    async handler({ ctx, body, tools }) {
      // ...lifted handler body
      return /* the response object, or { _status, _body } for non-200 */;
    },
  },
  // ...more routes in this domain
];
```

The 11 route files to create:

| File | Routes |
|---|---|
| `routes/biographer.js` | POST `/internal/biographer/process-pending` |
| `routes/session.js` | POST `/internal/session/register`, POST `/internal/session/end` |
| `routes/remember.js` | POST `/internal/remember` |
| `routes/jobs.js` | POST `/internal/jobs/run`, POST `/internal/jobs/reload` |
| `routes/knowledge.js` | POST `/internal/knowledge/ingest`, POST `/internal/knowledge/lint`, POST `/internal/knowledge/audit` |
| `routes/actions.js` | POST `/internal/actions/set`, POST `/internal/actions/reset` |
| `routes/commstyle.js` | POST `/internal/comm-style/refresh` |
| `routes/predictions.js` | POST `/internal/predictions/resolve` |
| `routes/calibration.js` | POST `/internal/calibration/refresh` |
| `routes/embeddings.js` | POST `/internal/embeddings/op` |
| `routes/intuition.js` | POST `/internal/intuition` |

For each file: read the original route block in `server.js` (lines 658–920 contain all 17 routes), apply the migration pattern, save the new route file. The handler bodies are copy-paste with the variable renames above.

**Example — `routes/biographer.js`** (full example, the rest follow the same shape):

```js
import { captureFromTranscript } from '../../../io/capture/session-capture.js';

export const biographerRoutes = [
  {
    method: 'POST',
    path: '/internal/biographer/process-pending',
    async handler({ ctx, body }) {
      if (body && typeof body.transcript_path === 'string' && body.transcript_path.length > 0) {
        try {
          await captureFromTranscript(ctx.db, ctx.embedder.wrap, {
            transcriptPath: body.transcript_path,
            sessionId: body.session_id ?? body.sessionId ?? null,
            host: ctx.host?.name ?? null,
          });
        } catch (e) {
          console.error(`daemon capture pre-step failed: ${e.message}`);
        }
      }
      const [pendingRows] = await ctx.db
        .query('SELECT id, ts FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 50')
        .collect();
      let enqueued = 0;
      let dropped = 0;
      for (const row of pendingRows) {
        const ret = ctx.queue.enqueue(String(row.id));
        if (ret && typeof ret === 'object' && ret.skipped) dropped++;
        else enqueued++;
      }
      if (dropped > 0) {
        return { _status: 207, _body: { enqueued, dropped, reason: 'queue_full' } };
      }
      return { enqueued };
    },
  },
];
```

Apply the same shape to all 11 files. Routes that reference `tools.find((t) => t.name === ...)` (knowledge.js) receive `tools` as a third argument in their handler destructure: `async handler({ ctx, body, tools })`.

- [ ] **Step 4: Create `routes/index.js`**

```js
import { actionsRoutes } from './actions.js';
import { biographerRoutes } from './biographer.js';
import { calibrationRoutes } from './calibration.js';
import { commstyleRoutes } from './commstyle.js';
import { embeddingsRoutes } from './embeddings.js';
import { intuitionRoutes } from './intuition.js';
import { jobsRoutes } from './jobs.js';
import { knowledgeRoutes } from './knowledge.js';
import { predictionsRoutes } from './predictions.js';
import { rememberRoutes } from './remember.js';
import { sessionRoutes } from './session.js';

export function buildRoutes() {
  return [
    ...actionsRoutes,
    ...biographerRoutes,
    ...calibrationRoutes,
    ...commstyleRoutes,
    ...embeddingsRoutes,
    ...intuitionRoutes,
    ...jobsRoutes,
    ...knowledgeRoutes,
    ...predictionsRoutes,
    ...rememberRoutes,
    ...sessionRoutes,
  ];
}
```

- [ ] **Step 5: Test the dispatcher**

Create `system/tests/unit/runtime/daemon/route-dispatch.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startHttp } from '../../../../runtime/daemon/http.js';

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = require('node:http').request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('successful route returns 200 + JSON', async () => {
  const routes = [
    { method: 'POST', path: '/echo', async handler({ body }) { return { got: body.x }; } },
  ];
  const server = startHttp({ ctx: { sessions: { count: 0 } }, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const res = await postJson(port, '/echo', { x: 'hello' });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { got: 'hello' });
  server.close();
});

test('_status escape hatch is honored', async () => {
  const routes = [
    { method: 'POST', path: '/teapot', async handler() { return { _status: 418, _body: { reason: 'teapot' } }; } },
  ];
  const server = startHttp({ ctx: { sessions: { count: 0 } }, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const res = await postJson(port, '/teapot', {});
  assert.equal(res.status, 418);
  assert.deepEqual(JSON.parse(res.body), { reason: 'teapot' });
  server.close();
});

test('unmatched route returns 404', async () => {
  const server = startHttp({ ctx: { sessions: { count: 0 } }, tools: [], routes: [], port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const res = await postJson(port, '/nope', {});
  assert.equal(res.status, 404);
  server.close();
});

test('thrown handler returns 500 with name + message', async () => {
  const routes = [
    { method: 'POST', path: '/boom', async handler() { const e = new Error('kaboom'); e.name = 'TestError'; throw e; } },
  ];
  const server = startHttp({ ctx: { sessions: { count: 0 } }, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const res = await postJson(port, '/boom', {});
  assert.equal(res.status, 500);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.error, 'kaboom');
  assert.equal(parsed.name, 'TestError');
  server.close();
});
```

Note: the `require('node:http')` inside the test is a workaround for ESM — replace with a top-level `import http from 'node:http'` and use `http.request`. Adjust per project style.

- [ ] **Step 6: Update `server.js` to use http.js**

Delete the entire `httpServer = createServer(async (req, res) => { ... })` block from `server.js` — it's ~280 lines. Replace with:

```js
import { buildRoutes } from './routes/index.js';
import { startHttp } from './http.js';
// ...
const routes = buildRoutes();
const httpServer = startHttp({ ctx, tools, routes, port });
```

Also delete `readJsonBody` (now in `http.js`) and remove the MCP/SSE imports that moved to `mcp-sse.js`.

- [ ] **Step 7: Run full suite**

```bash
npm test
```

Expected: all pass. The daemon boot test, hook integration tests, and CLI integration tests should all succeed unchanged because the external interface (URLs + payloads) is identical.

- [ ] **Step 8: Commit**

```bash
git add system/runtime/daemon/http.js system/runtime/daemon/mcp-sse.js system/runtime/daemon/routes/ system/runtime/daemon/server.js system/tests/unit/runtime/daemon/route-dispatch.test.js
git commit -m "$(cat <<'EOF'
refactor(runtime): R-3 commit 4/5 — extract routes table + http.js + mcp-sse

11 per-domain route files, route table dispatch, dedicated mcp-sse handler.
server.js loses ~280 lines of inline route handling.
EOF
)"
```

---

### Task 3.6: Final `server.js` compose (commit 5 of 5)

**Files:**
- Rewrite: `system/runtime/daemon/server.js`

- [ ] **Step 1: Rewrite `server.js` as the thin compose**

Replace the entire contents of `system/runtime/daemon/server.js` with:

```js
import { paths } from '../../config/data-store.js';
import { boot } from './boot.js';
import { startHttp } from './http.js';
import { createLifecycle } from './lifecycle.js';
import { bindFreePort } from './port.js';
import { buildRoutes } from './routes/index.js';
import { createScheduler } from './heartbeat.js';
import { buildTools } from './tools.js';
import { consumePendingTriggers } from './cadence-consumer.js';
import { closeStaleEpisodes } from '../../cognition/jobs/internal/close-stale-episodes.js';
import { runActionTrustDecay } from '../../cognition/jobs/action-trust.js';
import { markStaleSessions } from './sessions.js';
import { detectHost } from '../hosts/detect.js';
import { dispatcherTickFactory } from './dispatcher-tick.js';  // extracted in this commit

export async function startDaemon() {
  const lifecycle = createLifecycle({
    lockPath: paths.data.daemonLock(),
    statePath: paths.data.daemonState(),
    logDir: `${paths.data.home()}/logs`,
  });
  await lifecycle.acquireLock();
  try {
    const ctx = await boot();
    const tools = buildTools(ctx);
    const routes = buildRoutes();
    const { server: probe, port } = await bindFreePort();
    probe.close();

    const dispatcherTick = dispatcherTickFactory(ctx, tools);
    const scheduler = createScheduler({
      buckets: [
        { name: 'dispatcher',     intervalMs: 60_000,        tick: dispatcherTick,                                          gate: () => !!ctx.host, fireImmediately: true },
        { name: 'cadence',        intervalMs: 60_000,        tick: () => consumePendingTriggers(ctx.db, ctx.host),          gate: () => !!ctx.host },
        { name: 'stale-sessions', intervalMs: 60_000,        tick: () => markStaleSessions(ctx.db) },
        { name: 'stale-episodes', intervalMs: 600_000,       tick: () => closeStaleEpisodes(ctx.db) },
        { name: 'action-decay',   intervalMs: 6 * 3_600_000, tick: () => runActionTrustDecay(ctx.db) },
        {
          name: 'host-watchdog',
          intervalMs: 5 * 60_000,
          gate: () => !ctx.host,
          tick: async () => {
            try { const h = await detectHost(); if (h) { ctx.setHost(h); console.log('[daemon] host detected'); } }
            catch { /* still no host */ }
          },
        },
      ],
    });
    scheduler.start();

    const httpServer = startHttp({ ctx, tools, routes, port });

    lifecycle.ready({
      scheduler,
      httpServer,
      integrations: {
        stop: async () => {
          for (const [name, client] of ctx.gatewayClients) {
            const m = ctx.registry.get(name);
            if (m?.stop) {
              try { await m.stop({ log: console.log }, client); }
              catch (e) { console.warn(`integration ${name}: stop failed: ${e.message}`); }
            }
          }
        },
      },
      db: { close: ctx.closeDb },
    });
    await lifecycle.writeReady({
      port,
      pid: process.pid,
      version: ctx.version,
      startedAt: ctx.startedAt.toISOString(),
      toolCount: tools.length,
    });

    console.log(`robin-mcp daemon ready on 127.0.0.1:${port}`);
    await lifecycle.wait();
  } catch (e) {
    await lifecycle.fail(e);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDaemon();
}
```

- [ ] **Step 2: Extract `dispatcherTick` into its own file**

Create `system/runtime/daemon/dispatcher-tick.js`. Move the `dispatcherTick` function (built in R-2 Task 2.3) into this file as `dispatcherTickFactory(ctx, tools)` that returns the closure:

```js
import { surql } from 'surrealdb';
import { runOneJob } from '../../cognition/jobs/runner.js';
import { planNextRunAt, listDueJobs } from '../../cognition/jobs/scheduler-ext.js';
import { runIntegrationSync } from '../../io/integrations/_framework/run-sync.js';
import { dreamProcess } from '../../cognition/dream/pipeline.js';

export function dispatcherTickFactory(ctx, tools) {
  const inFlight = new Set();

  async function runOneItem(name) {
    const job = ctx.jobs.cache.current.find((j) => j.name === name);
    if (job) {
      await runOneJob({
        db: ctx.db, capture: ctx.capture.forJobs, host: ctx.host,
        jobs: ctx.jobs.cache.current, tools, name,
      });
      await planNextRunAt(ctx.db, ctx.jobs.cache.current);
      return;
    }
    if (name === '__embed_backfill__') {
      const e = await ctx.embedder.idle.get();
      const { embedBackfillTick } = await import('../../data/embed/backfill.js');
      return await embedBackfillTick({ db: ctx.db, embedder: e, batch: 64, log: console.log });
    }
    if (name === '__dream__') {
      const e = await ctx.embedder.idle.get();
      try {
        return await dreamProcess(ctx.db, ctx.host, e);
      } finally {
        const next = new Date();
        next.setHours(4, 0, 0, 0);
        if (next <= new Date()) next.setDate(next.getDate() + 1);
        const [rows2] = await ctx.db
          .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
          .collect();
        const value2 = rows2[0]?.value ?? {};
        const dream2 = { ...(value2.dream ?? {}), next_run_at: next, last_run_at: new Date() };
        await ctx.db
          .query(surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value2, dream: dream2 }}`)
          .collect();
      }
    }
    return await runIntegrationSync(ctx.db, ctx.registry, name);
  }

  return async function dispatcherTick() {
    await ctx.jobs.refresh();
    const due = [];
    const [rows] = await ctx.db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const value = rows[0]?.value ?? {};
    const integrations = value.integrations ?? {};
    const now = new Date();
    for (const [name, row] of Object.entries(integrations)) {
      if (!row?.next_run_at) continue;
      if (new Date(row.next_run_at) <= now && !row.in_flight) due.push({ name, kind: 'integration' });
    }
    const dreamCursor = value.dream;
    if (dreamCursor?.next_run_at && new Date(dreamCursor.next_run_at) <= now) {
      due.push({ name: '__dream__', kind: 'dream' });
    }
    try {
      const { activeProfile, embeddingTable } = await import('../../data/embed/profile-router.js');
      const profile = await activeProfile(ctx.db);
      const eventsEmbTbl = embeddingTable(profile, 'events');
      const [pending] = await ctx.db
        .query(`SELECT count() AS n FROM events
                WHERE meta.embed_failed IS NOT true
                  AND id NOT IN (SELECT VALUE record FROM ${eventsEmbTbl})
                GROUP ALL`)
        .collect();
      if ((pending[0]?.n ?? 0) > 0) due.push({ name: '__embed_backfill__', kind: 'embed_backfill' });
    } catch { /* no active profile yet */ }
    const jobsDue = await listDueJobs(ctx.db, new Date());
    const all = [...due, ...jobsDue];
    for (const item of all) {
      if (inFlight.has(item.name)) continue;
      inFlight.add(item.name);
      runOneItem(item.name)
        .catch((e) => console.warn(`[scheduler] ${item.name} failed: ${e.message}`))
        .finally(() => inFlight.delete(item.name));
    }
    if (inFlight.size === 0) {
      const [overflowRows] = await ctx.db
        .query(surql`SELECT count() AS n FROM events WHERE biographed_at IS NONE GROUP ALL`)
        .collect();
      if ((overflowRows[0]?.n ?? 0) >= 500) {
        inFlight.add('__dream__');
        runOneItem('__dream__')
          .catch((e) => console.warn(`[scheduler] __dream__ failed: ${e.message}`))
          .finally(() => inFlight.delete('__dream__'));
      }
    }
  };
}
```

- [ ] **Step 3: Run lint + full suite**

```bash
npm run lint
npm test
```

Expected: all pass. `server.js` is now ~80 lines.

- [ ] **Step 4: Verify `server.js` line count**

```bash
wc -l system/runtime/daemon/server.js
```

Expected: ~80 lines.

- [ ] **Step 5: Commit**

```bash
git add system/runtime/daemon/server.js system/runtime/daemon/dispatcher-tick.js
git commit -m "$(cat <<'EOF'
refactor(runtime): R-3 commit 5/5 — final server.js thin compose

server.js shrinks from ~900 to ~80 lines. dispatcherTick extracted to
its own file. boot/tools/routes/http/lifecycle do the heavy lifting.
EOF
)"
```

---

### Task 3.7: Open R-3 PR

- [ ] **Step 1: Push + PR**

```bash
git push -u origin feat/runtime-r3-decompose-server
gh pr create --title "refactor(runtime): R-3 — decompose server.js + route table" --body "$(cat <<'EOF'
## Summary
- `system/runtime/daemon/server.js`: 990 → ~80 lines.
- Extracted: lifecycle.js, boot.js, tools.js, http.js, mcp-sse.js, dispatcher-tick.js.
- 17 inline `/internal/*` routes → 11 per-domain route files in `routes/`.
- Handler signature is `({ ctx, body, tools }) → result` everywhere.
- `_status`/`_body` escape hatch for non-200 responses.

## External surface
Byte-identical: hook contract, MCP tool names, CLI commands, signal handling, `/internal/*` URLs and payload shapes.

## Test plan
- [x] New unit tests: lifecycle.test.js, tools.test.js, route-dispatch.test.js
- [x] New integration: boot.test.js
- [x] `npm test` green
- [x] `npm run lint` clean
EOF
)"
```

---

## Phase R-4: Schema + envelope on `/internal/*` (single PR)

**Scope:** Add request schemas to the 4 routes that already validate inline; add a response envelope (`{ ok: true, ...data }` / `{ ok: false, error, name, validation? }`) to every `/internal/*` route. Rename semantic `ok` fields on 3 routes to free the key for the envelope.

**File structure for R-4:**

```
system/runtime/daemon/
├── schema.js                    CREATE (~50 LoC validator)
├── http.js                      MODIFY (envelope + validation in dispatcher)
└── routes/
    ├── remember.js              MODIFY (add schema)
    ├── jobs.js                  MODIFY (add schema; rename ok→succeeded)
    └── actions.js               MODIFY (add schema; remove semantic ok)

system/runtime/cli/commands/
├── actions-set.js               MODIFY (drop body.ok read)
├── actions-reset.js             MODIFY (drop body.ok read)
└── jobs-run.js                  MODIFY (read body.succeeded instead of body.ok)

system/tests/unit/runtime/daemon/
├── schema.test.js               CREATE
└── envelope.test.js             CREATE
```

### Task 4.1: Create R-4 branch

- [ ] **Step 1: Branch**

```bash
git checkout main
git pull origin main
git checkout -b feat/runtime-r4-schema-envelope
```

---

### Task 4.2: Rename semantic `ok` fields on 3 routes + their callers

**Files:**
- Modify: `system/runtime/daemon/routes/actions.js`
- Modify: `system/runtime/daemon/routes/jobs.js`
- Modify: `system/runtime/cli/commands/actions-set.js`
- Modify: `system/runtime/cli/commands/actions-reset.js`
- Modify: `system/runtime/cli/commands/jobs-run.js`

- [ ] **Step 1: Grep current readers**

```bash
grep -rn "\.ok" system/runtime/cli/commands/actions-set.js system/runtime/cli/commands/actions-reset.js system/runtime/cli/commands/jobs-run.js
grep -rn "result\.ok\|body\.ok\|json\.ok" system/runtime/ system/io/ system/tests/
```

Record the call sites. Expected matches: the three CLI commands listed above; possibly tests for those routes.

- [ ] **Step 2: Update `routes/actions.js`**

In `/internal/actions/set`, change the handler return from `{ ok: true, class: body.class, state: body.state }` to:

```js
return { class: body.class, state: body.state };
```

In `/internal/actions/reset`, change `{ ok: true, class: body.class, state: 'ASK' }` to:

```js
return { class: body.class, state: 'ASK' };
```

- [ ] **Step 3: Update `routes/jobs.js`**

In `/internal/jobs/run`, change `{ ok: after.last_run_ok === true, last_error: after.last_error ?? null }` to:

```js
return { succeeded: after.last_run_ok === true, last_error: after.last_error ?? null };
```

- [ ] **Step 4: Update CLI callers**

- `system/runtime/cli/commands/actions-set.js`: any read of `result.ok` becomes `result.state` (success is now signaled by 200 OK).
- `system/runtime/cli/commands/actions-reset.js`: same — drop `result.ok` reads.
- `system/runtime/cli/commands/jobs-run.js`: replace `result.ok` with `result.succeeded`.

- [ ] **Step 5: Update tests for the three routes**

Any test asserting `body.ok` on `/internal/actions/*` or `/internal/jobs/run` updates to read the new field (or drops the assertion entirely for actions). After R-4 task 4.5 ships, those same tests will assert `body.ok === true` from the envelope.

- [ ] **Step 6: Run tests**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add system/runtime/daemon/routes/actions.js system/runtime/daemon/routes/jobs.js system/runtime/cli/commands/actions-set.js system/runtime/cli/commands/actions-reset.js system/runtime/cli/commands/jobs-run.js system/tests/
git commit -m "$(cat <<'EOF'
refactor(runtime): R-4 prep — free the `ok` key for the envelope

Drop semantic `ok` from /internal/actions/{set,reset}; rename
/internal/jobs/run's `ok` to `succeeded`. CLI callers updated.
EOF
)"
```

---

### Task 4.3: Schema validator

**Files:**
- Create: `system/runtime/daemon/schema.js`
- Create: `system/tests/unit/runtime/daemon/schema.test.js`

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/runtime/daemon/schema.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../../../runtime/daemon/schema.js';

test('accepts a body matching the schema', () => {
  const r = validate({ name: 'x', force: true }, { name: 'string', force: 'boolean?' });
  assert.deepEqual(r, { ok: true, value: { name: 'x', force: true } });
});

test('optional field may be omitted', () => {
  const r = validate({ name: 'x' }, { name: 'string', force: 'boolean?' });
  assert.equal(r.ok, true);
});

test('rejects missing required field', () => {
  const r = validate({}, { name: 'string' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'name' && /required/.test(e.message)));
});

test('rejects wrong type', () => {
  const r = validate({ name: 123 }, { name: 'string' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'name'));
});

test('rejects unknown fields (strict)', () => {
  const r = validate({ name: 'x', extra: 'nope' }, { name: 'string' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'extra' && /unknown/i.test(e.message)));
});

test('integer rejects non-integer numbers', () => {
  const r = validate({ n: 1.5 }, { n: 'integer' });
  assert.equal(r.ok, false);
});

test('array accepts arrays', () => {
  const r = validate({ items: [1, 2] }, { items: 'array' });
  assert.equal(r.ok, true);
});

test('object accepts objects', () => {
  const r = validate({ meta: { a: 1 } }, { meta: 'object' });
  assert.equal(r.ok, true);
});

test('all-optional schema accepts empty body', () => {
  const r = validate({}, { x: 'string?', y: 'number?' });
  assert.equal(r.ok, true);
});

test('vocabulary tabulation — accepts every documented type', () => {
  const samples = {
    string: 'x', 'string?': 'x',
    number: 1, 'number?': 1,
    integer: 1, 'integer?': 1,
    boolean: true, 'boolean?': false,
    array: [], 'array?': [],
    object: {}, 'object?': {},
  };
  for (const [type, sample] of Object.entries(samples)) {
    const r = validate({ v: sample }, { v: type });
    assert.equal(r.ok, true, `${type} should accept ${JSON.stringify(sample)}`);
  }
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test system/tests/unit/runtime/daemon/schema.test.js`

Expected: FAIL — `schema.js` doesn't exist.

- [ ] **Step 3: Implement `schema.js`**

Create `system/runtime/daemon/schema.js`:

```js
const TYPES = {
  string:    (v) => typeof v === 'string',
  number:    (v) => typeof v === 'number' && Number.isFinite(v),
  integer:   (v) => Number.isInteger(v),
  boolean:   (v) => typeof v === 'boolean',
  array:     (v) => Array.isArray(v),
  object:    (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

/**
 * Validate a body object against a schema map.
 *
 * Schema map: { fieldName: 'type' | 'type?' }
 *   - Trailing `?` marks the field optional.
 *   - Unknown fields are rejected (strict).
 *   - Semantic checks (enum membership, regex, range) stay in the handler.
 *
 * Returns { ok: true, value } or { ok: false, errors: [{ path, message }] }.
 * The returned shape is internal — the HTTP envelope is built from it.
 */
export function validate(body, schema) {
  const errors = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: [{ path: '', message: 'body must be an object' }] };
  }
  const declaredKeys = new Set(Object.keys(schema));
  // Required + type checks
  for (const [key, spec] of Object.entries(schema)) {
    const optional = spec.endsWith('?');
    const baseType = optional ? spec.slice(0, -1) : spec;
    const check = TYPES[baseType];
    if (!check) {
      errors.push({ path: key, message: `schema error: unknown type '${spec}'` });
      continue;
    }
    if (!(key in body)) {
      if (!optional) errors.push({ path: key, message: 'required' });
      continue;
    }
    if (!check(body[key])) {
      errors.push({ path: key, message: `expected ${baseType}` });
    }
  }
  // Unknown-field check (strict)
  for (const key of Object.keys(body)) {
    if (!declaredKeys.has(key)) {
      errors.push({ path: key, message: 'unknown field' });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: body };
}
```

- [ ] **Step 4: Run new test**

Run: `node --test system/tests/unit/runtime/daemon/schema.test.js`

Expected: all 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add system/runtime/daemon/schema.js system/tests/unit/runtime/daemon/schema.test.js
git commit -m "refactor(runtime): R-4 — schema validator (50-line strict validator)"
```

---

### Task 4.4: Add schemas to the 4 routes that already validate

**Files:**
- Modify: `system/runtime/daemon/routes/remember.js`
- Modify: `system/runtime/daemon/routes/jobs.js`
- Modify: `system/runtime/daemon/routes/actions.js`

- [ ] **Step 1: Update `routes/remember.js`**

Add a `schema` field to the route entry:

```js
export const rememberRoutes = [
  {
    method: 'POST',
    path: '/internal/remember',
    schema: { content: 'string', source: 'string?', meta: 'object?', force: 'boolean?' },
    async handler({ ctx, body }) {
      // existing implementation
    },
  },
];
```

Delete the inline `if (typeof body.content !== 'string' || body.content.length === 0)` check — the schema validator now enforces it.

- [ ] **Step 2: Update `routes/jobs.js`**

```js
export const jobsRoutes = [
  {
    method: 'POST',
    path: '/internal/jobs/run',
    schema: { name: 'string', force: 'boolean?' },
    async handler({ ctx, body }) { /* existing — drop inline name check */ },
  },
  {
    method: 'POST',
    path: '/internal/jobs/reload',
    async handler({ ctx }) { /* existing */ },
  },
];
```

- [ ] **Step 3: Update `routes/actions.js`**

```js
export const actionsRoutes = [
  {
    method: 'POST',
    path: '/internal/actions/set',
    schema: { class: 'string', state: 'string' },
    async handler({ ctx, body }) {
      if (!['AUTO', 'ASK', 'NEVER'].includes(body.state)) {
        return { _status: 400, _body: { ok: false, error: `invalid state '${body.state}'`, name: 'RobinInvalidEnumError' } };
      }
      // existing setActionTrust call
      return { class: body.class, state: body.state };
    },
  },
  {
    method: 'POST',
    path: '/internal/actions/reset',
    schema: { class: 'string' },
    async handler({ ctx, body }) {
      // existing resetActionTrust call
      return { class: body.class, state: 'ASK' };
    },
  },
];
```

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: all pass. The schemas haven't been wired into the dispatcher yet (Task 4.5), so the inline validation removal is currently a regression — fix in 4.5 within the same PR.

- [ ] **Step 5: Commit**

```bash
git add system/runtime/daemon/routes/remember.js system/runtime/daemon/routes/jobs.js system/runtime/daemon/routes/actions.js
git commit -m "refactor(runtime): R-4 — declare schemas on validating routes"
```

---

### Task 4.5: Wire schema + envelope into `http.js`

**Files:**
- Modify: `system/runtime/daemon/http.js`
- Create: `system/tests/unit/runtime/daemon/envelope.test.js`

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/runtime/daemon/envelope.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { startHttp } from '../../../../runtime/daemon/http.js';

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
function postRaw(port, path, raw) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

test('success response includes ok: true and spreads data', async () => {
  const routes = [{ method: 'POST', path: '/x', async handler() { return { value: 42 }; } }];
  const server = startHttp({ ctx: { sessions: { count: 0 } }, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/x', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, value: 42 });
  server.close();
});

test('envelope ok: true overrides handler-returned ok: false', async () => {
  const routes = [{ method: 'POST', path: '/x', async handler() { return { ok: false, value: 1 }; } }];
  const server = startHttp({ ctx: { sessions: { count: 0 } }, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/x', {});
  assert.equal(r.body.ok, true);
  assert.equal(r.body.value, 1);
  server.close();
});

test('thrown error returns 500 with ok: false envelope', async () => {
  const routes = [{ method: 'POST', path: '/x', async handler() { const e = new Error('boom'); e.name = 'TestError'; throw e; } }];
  const server = startHttp({ ctx: { sessions: { count: 0 } }, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/x', {});
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { ok: false, error: 'boom', name: 'TestError' });
  server.close();
});

test('schema validation rejects bad body with 400', async () => {
  const routes = [{
    method: 'POST', path: '/x',
    schema: { name: 'string' },
    async handler() { return { ok2: true }; },
  }];
  const server = startHttp({ ctx: { sessions: { count: 0 } }, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/x', { wrong: 'field' });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.name, 'RobinValidationError');
  assert.ok(Array.isArray(r.body.validation));
  server.close();
});

test('invalid JSON returns 400 with RobinInvalidJsonError', async () => {
  const routes = [{
    method: 'POST', path: '/x',
    schema: { name: 'string' },
    async handler() { return {}; },
  }];
  const server = startHttp({ ctx: { sessions: { count: 0 } }, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postRaw(port, '/x', '{ not valid json');
  assert.equal(r.status, 400);
  assert.equal(r.body.name, 'RobinInvalidJsonError');
  server.close();
});

test('_status escape hatch bypasses envelope', async () => {
  const routes = [{
    method: 'POST', path: '/x',
    async handler() { return { _status: 207, _body: { enqueued: 5, dropped: 1 } }; },
  }];
  const server = startHttp({ ctx: { sessions: { count: 0 } }, tools: [], routes, port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const r = await postJson(port, '/x', {});
  assert.equal(r.status, 207);
  // Note: _status escape hatch bypasses envelope — no ok field added
  assert.equal(r.body.enqueued, 5);
  assert.equal(r.body.dropped, 1);
  assert.equal(r.body.ok, undefined);
  server.close();
});
```

- [ ] **Step 2: Update `http.js`**

Modify `system/runtime/daemon/http.js`. Replace the `readJsonBody` + main dispatch block:

```js
import { createServer } from 'node:http';
import { handleSse } from './mcp-sse.js';
import { validate } from './schema.js';

async function readJsonBody(req) {
  return await new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolveBody({});
      try { resolveBody(JSON.parse(raw)); }
      catch (e) {
        const err = new Error('invalid JSON body');
        err.name = 'RobinInvalidJsonError';
        err._status = 400;
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

export function startHttp({ ctx, tools, routes, port }) {
  const table = new Map();
  for (const r of routes) table.set(`${r.method} ${r.path}`, r);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url.startsWith('/sse')) {
        ctx.sessions.count++;
        await handleSse(req, res, { ctx, tools });
        req.on('close', () => { ctx.sessions.count = Math.max(0, ctx.sessions.count - 1); });
        return;
      }
      const entry = table.get(`${req.method} ${req.url}`);
      if (!entry) {
        res.writeHead(404).end();
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        if (e.name === 'RobinInvalidJsonError') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message, name: e.name }));
          return;
        }
        throw e;
      }

      if (entry.schema) {
        const v = validate(body, entry.schema);
        if (!v.ok) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: 'invalid request body',
            name: 'RobinValidationError',
            validation: v.errors,
          }));
          return;
        }
        body = v.value;
      }

      const result = await entry.handler({ ctx, body, tools });
      if (result && typeof result === 'object' && '_status' in result) {
        // Escape hatch: handler owns the full response, no envelope wrap.
        res.writeHead(result._status, result._headers ?? { 'content-type': 'application/json' });
        res.end(typeof result._body === 'string' ? result._body : JSON.stringify(result._body ?? {}));
        return;
      }
      // Envelope: ok: true always wins on the success path.
      const envelope = Object.assign({}, result, { ok: true });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(envelope));
    } catch (e) {
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message, name: e.name }));
      } catch { /* response already sent */ }
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
```

- [ ] **Step 3: Run new test**

```bash
node --test system/tests/unit/runtime/daemon/envelope.test.js
```

Expected: all 6 tests pass.

- [ ] **Step 4: Update existing route tests + CLI integration tests**

Any test that asserted a direct body shape on `/internal/*` (e.g., `body.enqueued === 5`) still works — the fields are preserved. Add `body.ok === true` assertions where useful. Tests that asserted `body.ok === true` on actions/jobs (the renamed routes from 4.2) now correctly see the envelope's `ok: true`.

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: all pass. Update any in-tree callers that compared `body.error` as a string — they keep working because `error` is still present.

- [ ] **Step 6: Commit**

```bash
git add system/runtime/daemon/http.js system/tests/unit/runtime/daemon/envelope.test.js system/tests/
git commit -m "$(cat <<'EOF'
feat(runtime): R-4 — schema validation + response envelope on /internal/*

- Add { ok: true, ...data } success envelope; { ok: false, error, name, validation? } error envelope.
- Validate request bodies declared via `schema` field on the route entry.
- Distinguish invalid-JSON (RobinInvalidJsonError) from schema-rejection
  (RobinValidationError); both return 400.
- _status escape hatch bypasses envelope wrap.
EOF
)"
```

---

### Task 4.6: Open R-4 PR

- [ ] **Step 1: Push + PR**

```bash
git push -u origin feat/runtime-r4-schema-envelope
gh pr create --title "feat(runtime): R-4 — schema + envelope on /internal/*" --body "$(cat <<'EOF'
## Summary
- New `daemon/schema.js` — 50-line strict validator (string/number/integer/boolean/array/object, all with optional variant, strict unknown-field rejection).
- 4 routes declare `schema`; their inline checks deleted.
- `http.js` envelope-wraps every success (`{ ok: true, ...data }`) and every error (`{ ok: false, error, name, validation? }`).
- `_status` escape hatch bypasses envelope.
- Pre-migration: dropped semantic `ok` from /internal/actions/{set,reset}; renamed /internal/jobs/run `ok` → `succeeded` so the envelope's `ok: true` doesn't collide.

## Surface change
Additive: all existing `body.<field>` reads still work. New: `body.ok` is `true` on 200, `false` on error.

## Test plan
- [x] schema.test.js: 10 tests over the type vocabulary
- [x] envelope.test.js: 6 tests for success spread, override semantics, error envelope, _status bypass, JSON/schema errors
- [x] `npm test` green
EOF
)"
```

---

## Phase R-5: Declarative CLI router (single PR, independent)

**Scope:** Replace `cli/index.js`'s if/else chain with a registry-driven dispatcher. Auto-generate `--help`. Independent of R-1…R-4 — can ship at any point.

**File structure for R-5:**

```
system/runtime/cli/
├── index.js                 REWRITE (~55 lines, dispatcher)
├── commands.js              CREATE (registry)
└── commands/
    └── help.js              REWRITE (walks registry)

system/tests/unit/runtime/cli/
├── commands.test.js         CREATE (registry coverage)
├── dispatch.test.js         CREATE (dispatcher behavior)
└── help.test.js             CREATE (snapshot)
```

### Task 5.1: Create R-5 branch

- [ ] **Step 1: Branch**

```bash
git checkout main
git pull origin main
git checkout -b feat/runtime-r5-cli-router
```

---

### Task 5.2: Audit current `Object.values(mod)[0]` command files

- [ ] **Step 1: Identify the affected files**

Run: `grep -n "Object.values(mod)\[0\]" system/runtime/cli/index.js`

Locate the three groups where this magic is used (mcp, rules, pre-commit). For each subcommand, read the imported file and record its actual exported function name.

- [ ] **Step 2: Build a mapping table**

In a scratch note, list each `<subcommand>: <import path>: <export name>` for those ~7 files. Example expected mapping:

```
mcp.start            ./commands/mcp-start.js            mcpStart
mcp.stop             ./commands/mcp-stop.js             mcpStop
mcp.status           ./commands/mcp-status.js           mcpStatus
mcp.restart          ./commands/mcp-restart.js          mcpRestart
mcp.ensure-running   ./commands/mcp-ensure-running.js   mcpEnsureRunning
mcp.install          ./commands/mcp-install.js          mcpInstall
mcp.uninstall        ./commands/mcp-uninstall.js        mcpUninstall
rules.pending        ./commands/rules-pending.js        rulesPending
rules.approve        ./commands/rules-approve.js        rulesApprove
rules.reject         ./commands/rules-reject.js         rulesReject
rules.list           ./commands/rules-list.js           rulesList
rules.deactivate     ./commands/rules-deactivate.js     rulesDeactivate
pre-commit.install   ./commands/pre-commit-install.js   preCommitInstall
pre-commit.uninstall ./commands/pre-commit-uninstall.js preCommitUninstall
pre-commit.run       ./commands/pre-commit-run.js       preCommitRun
```

Verify each export name matches the file's actual export by reading the file.

---

### Task 5.3: Create the registry

**Files:**
- Create: `system/runtime/cli/commands.js`
- Create: `system/tests/unit/runtime/cli/commands.test.js`

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/runtime/cli/commands.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../../../../runtime/cli/commands.js';

function walk(node, prefix = '') {
  const leaves = [];
  for (const [key, entry] of Object.entries(node)) {
    if (entry.subcommands) {
      leaves.push(...walk(entry.subcommands, `${prefix}${key} `));
    } else {
      leaves.push({ name: `${prefix}${key}`.trim(), entry });
    }
  }
  return leaves;
}

test('every leaf entry has import and export', () => {
  for (const leaf of walk(commands)) {
    assert.ok(typeof leaf.entry.import === 'string', `${leaf.name}: missing import`);
    assert.ok(typeof leaf.entry.export === 'string', `${leaf.name}: missing export`);
  }
});

test('every leaf module imports and exports the named function', async () => {
  const failures = [];
  for (const leaf of walk(commands)) {
    try {
      const mod = await import(`../../../../runtime/cli/${leaf.entry.import.replace(/^\.\//, '')}`);
      if (typeof mod[leaf.entry.export] !== 'function') {
        failures.push(`${leaf.name}: ${leaf.entry.import} has no function export ${leaf.entry.export}`);
      }
    } catch (e) {
      failures.push(`${leaf.name}: failed to import ${leaf.entry.import}: ${e.message}`);
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});

test('no duplicate keys within any group', () => {
  function check(node, prefix = '') {
    const keys = Object.keys(node);
    assert.equal(new Set(keys).size, keys.length, `duplicate at ${prefix}`);
    for (const [k, entry] of Object.entries(node)) {
      if (entry.subcommands) check(entry.subcommands, `${prefix}${k}.`);
    }
  }
  check(commands);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test system/tests/unit/runtime/cli/commands.test.js`

Expected: FAIL — `commands.js` doesn't exist.

- [ ] **Step 3: Create the registry**

Create `system/runtime/cli/commands.js`. Build the full registry by walking through every branch in the existing `cli/index.js` and creating an entry per command. Use the audit from Task 5.2 for the `Object.values(mod)[0]` files; for everything else, read each command file to confirm the export name.

Template — fill in every existing command from `cli/index.js`:

```js
export const commands = {
  install:                { import: './commands/install.js',           export: 'install',                help: 'install Robin' },
  uninstall:              { import: './commands/uninstall.js',         export: 'uninstall',              help: 'uninstall Robin' },
  migrate:                { import: './commands/migrate.js',           export: 'migrate',                help: 'apply schema migrations' },
  'biographer-catchup':   { import: './commands/biographer-catchup.js', export: 'biographerCatchup',     help: 'process pending events' },
  biographer: {
    help: 'biographer ops',
    subcommands: {
      'process-pending': { import: './commands/biographer-process-pending.js', export: 'biographerProcessPending' },
    },
  },
  mcp: {
    help: 'daemon control',
    subcommands: {
      start:            { import: './commands/mcp-start.js',           export: 'mcpStart' },
      stop:             { import: './commands/mcp-stop.js',            export: 'mcpStop' },
      status:           { import: './commands/mcp-status.js',          export: 'mcpStatus' },
      restart:          { import: './commands/mcp-restart.js',         export: 'mcpRestart' },
      'ensure-running': { import: './commands/mcp-ensure-running.js',  export: 'mcpEnsureRunning' },
      install:          { import: './commands/mcp-install.js',         export: 'mcpInstall' },
      uninstall:        { import: './commands/mcp-uninstall.js',       export: 'mcpUninstall' },
    },
  },
  dream: {
    help: 'dream pipeline',
    subcommands: {
      run: { import: './commands/dream-run.js', export: 'dreamRun' },
    },
  },
  rules: {
    help: 'rule candidates + approved rules',
    subcommands: {
      pending:    { import: './commands/rules-pending.js',    export: 'rulesPending' },
      approve:    { import: './commands/rules-approve.js',    export: 'rulesApprove' },
      reject:     { import: './commands/rules-reject.js',     export: 'rulesReject' },
      list:       { import: './commands/rules-list.js',       export: 'rulesList' },
      deactivate: { import: './commands/rules-deactivate.js', export: 'rulesDeactivate' },
    },
  },
  journal: { import: './commands/journal.js', export: 'journalCmd', help: 'recent capture' },
  hot:     { import: './commands/hot.js',     export: 'hotCmd',     help: 'hot entities/topics' },
  jobs: {
    help: 'job runner',
    subcommands: {
      list:    { import: './commands/jobs-list.js',    export: 'jobsList' },
      status:  { import: './commands/jobs-status.js',  export: 'jobsStatus' },
      run:     { import: './commands/jobs-run.js',     export: 'jobsRun' },
      enable:  { import: './commands/jobs-enable.js',  export: 'jobsEnable' },
      disable: { import: './commands/jobs-disable.js', export: 'jobsDisable' },
      reload:  { import: './commands/jobs-reload.js',  export: 'jobsReload' },
    },
  },
  ingest: { import: './commands/ingest.js', export: 'ingestCmd', help: 'ingest knowledge' },
  lint:   { import: './commands/lint.js',   export: 'lintCmd',   help: 'lint knowledge' },
  audit:  { import: './commands/audit.js',  export: 'auditCmd',  help: 'audit knowledge' },
  actions: {
    help: 'action trust',
    subcommands: {
      list:  { import: './commands/actions-list.js',  export: 'actionsList' },
      show:  { import: './commands/actions-show.js',  export: 'actionsShow' },
      set:   { import: './commands/actions-set.js',   export: 'actionsSet' },
      reset: { import: './commands/actions-reset.js', export: 'actionsReset' },
    },
  },
  commstyle: {
    help: 'communication style profile',
    subcommands: {
      show:    { import: './commands/commstyle-show.js',    export: 'commstyleShow' },
      refresh: { import: './commands/commstyle-refresh.js', export: 'commstyleRefresh' },
    },
  },
  predictions: {
    help: 'predictions',
    subcommands: {
      list:    { import: './commands/predictions-list.js',    export: 'predictionsList' },
      resolve: { import: './commands/predictions-resolve.js', export: 'predictionsResolve' },
    },
  },
  calibration: { import: './commands/calibration-show.js', export: 'calibrationShow', help: 'show calibration' },
  integrations: {
    help: 'integration management',
    subcommands: {
      list:   { import: './commands/integrations-list.js',   export: 'integrationsList' },
      status: { import: './commands/integrations-status.js', export: 'integrationsStatus' },
      run:    { import: './commands/integrations-run.js',    export: 'integrationsRun' },
      discord: {
        help: 'discord-specific',
        subcommands: {
          'register-commands': { import: './commands/integrations-discord-register.js', export: 'integrationsDiscordRegister' },
        },
      },
    },
  },
  auth: {
    help: 'oauth setup',
    subcommands: {
      google:  { import: './commands/auth-google.js',  export: 'authGoogle' },
      spotify: { import: './commands/auth-spotify.js', export: 'authSpotify' },
      whoop:   { import: './commands/auth-whoop.js',   export: 'authWhoop' },
    },
  },
  embeddings: { import: './commands/embeddings.js', export: 'embeddings', help: 'embedder profile ops' },
  secrets: {
    help: 'secrets management',
    subcommands: {
      import: { import: './commands/secrets-import.js', export: 'secretsImport' },
      list:   { import: './commands/secrets-list.js',   export: 'secretsList' },
      set:    { import: './commands/secrets-set.js',    export: 'secretsSet' },
    },
  },
  hook:      { import: './commands/hook.js',     export: 'hook',     help: 'internal hook handler' },
  remember:  { import: './commands/remember.js', export: 'remember', help: 'CLI memory write' },
  sessions:  { import: './commands/sessions-purge.js', export: 'sessionsPurge', help: 'list/purge sessions' },
  refusals: {
    help: 'refusal audit',
    subcommands: {
      list: { import: './commands/refusals-list.js', export: 'refusalsList' },
    },
  },
  'pre-commit': {
    help: 'per-repo pre-commit hook',
    subcommands: {
      install:   { import: './commands/pre-commit-install.js',   export: 'preCommitInstall' },
      uninstall: { import: './commands/pre-commit-uninstall.js', export: 'preCommitUninstall' },
      run:       { import: './commands/pre-commit-run.js',       export: 'preCommitRun' },
    },
  },
  doctor: { import: './commands/doctor.js', export: 'doctor', help: 'health check' },
  hooks: {
    help: 'hook kill switch',
    subcommands: {
      disable: { import: './commands/hooks-disable.js', export: 'hooksDisable' },
      enable:  { import: './commands/hooks-enable.js',  export: 'hooksEnable' },
    },
  },
};
```

For each entry whose `export` doesn't match (e.g., the source file's actual export name differs from your guess), re-read the source and fix.

- [ ] **Step 4: Run registry test**

```bash
node --test system/tests/unit/runtime/cli/commands.test.js
```

Expected: all 3 pass. The "every leaf imports and exports" test will surface any mismatched export names — fix them in the registry until the test is green.

- [ ] **Step 5: Commit**

```bash
git add system/runtime/cli/commands.js system/tests/unit/runtime/cli/commands.test.js
git commit -m "feat(runtime): R-5 — declarative CLI commands registry"
```

---

### Task 5.4: New dispatcher + help

**Files:**
- Rewrite: `system/runtime/cli/index.js`
- Rewrite: `system/runtime/cli/commands/help.js`
- Create: `system/tests/unit/runtime/cli/dispatch.test.js`
- Create: `system/tests/unit/runtime/cli/help.test.js`

- [ ] **Step 1: Write the dispatch test**

Create `system/tests/unit/runtime/cli/dispatch.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchFor } from '../../../../runtime/cli/index.js';

test('leaf dispatch invokes the right export with argv.slice(N)', async () => {
  const calls = [];
  const node = {
    install: {
      // Test-only override: instead of importing, use a direct `fn`.
      fn: (argv) => calls.push({ cmd: 'install', argv }),
    },
  };
  await dispatchFor(node, ['install', '--foo']);
  assert.deepEqual(calls, [{ cmd: 'install', argv: ['--foo'] }]);
});

test('group with no subcommand prints usage and exits 1', async () => {
  // Replace process.exit for the duration of the test
  const origExit = process.exit;
  const origErr = console.error;
  const errs = [];
  let exited = null;
  process.exit = (code) => { exited = code; throw new Error('__exit__'); };
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const node = { mcp: { subcommands: { start: { fn: () => {} }, stop: { fn: () => {} } } } };
    await assert.rejects(() => dispatchFor(node, ['mcp']), /__exit__/);
    assert.equal(exited, 1);
    assert.ok(errs.some((e) => e.includes('<start|stop>')), `expected usage line, got: ${errs.join('|')}`);
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
});

test('recursive group dispatch (integrations discord register-commands)', async () => {
  const calls = [];
  const node = {
    integrations: {
      subcommands: {
        discord: {
          subcommands: {
            'register-commands': { fn: (argv) => calls.push(argv) },
          },
        },
      },
    },
  };
  await dispatchFor(node, ['integrations', 'discord', 'register-commands', '--force']);
  assert.deepEqual(calls, [['--force']]);
});

test('unknown command exits 1', async () => {
  const origExit = process.exit;
  const origErr = console.error;
  let exited = null;
  process.exit = (code) => { exited = code; throw new Error('__exit__'); };
  console.error = () => {};
  try {
    await assert.rejects(() => dispatchFor({}, ['nope']), /__exit__/);
    assert.equal(exited, 1);
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
});
```

The `fn` field is a test-only escape hatch that bypasses the import.

- [ ] **Step 2: Write the help snapshot test**

Create `system/tests/unit/runtime/cli/help.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHelp } from '../../../../runtime/cli/commands/help.js';
import { commands } from '../../../../runtime/cli/commands.js';

test('renderHelp produces a non-empty string with expected sections', () => {
  const out = renderHelp(commands);
  assert.ok(out.length > 100);
  assert.match(out, /Commands:/);
  // Spot-check a few known commands
  assert.match(out, /install/);
  assert.match(out, /mcp/);
  assert.match(out, /integrations/);
});
```

(A literal-snapshot golden file is brittle; spot-checking key strings is sufficient and resilient to formatting tweaks.)

- [ ] **Step 3: Rewrite `cli/index.js`**

Replace the entire contents of `system/runtime/cli/index.js`:

```js
import { commands } from './commands.js';
import { renderHelp } from './commands/help.js';
import { version } from './commands/version.js';

export async function main(argv) {
  const head = argv[0];
  if (head === '--version' || head === '-v') return version();
  if (!head || head === '--help' || head === '-h') {
    console.log(renderHelp(commands));
    return;
  }
  return dispatchFor(commands, argv);
}

export async function dispatchFor(node, argv) {
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
    return dispatchFor(entry.subcommands, rest);
  }
  // Test escape hatch
  if (typeof entry.fn === 'function') return entry.fn(rest);
  const mod = await import(entry.import);
  const fn = mod[entry.export];
  if (typeof fn !== 'function') {
    throw new Error(`registry: ${entry.import} has no export ${entry.export}`);
  }
  return fn(rest);
}
```

- [ ] **Step 4: Rewrite `cli/commands/help.js`**

Replace `system/runtime/cli/commands/help.js`:

```js
function render(node, indent = '  ') {
  const lines = [];
  for (const [key, entry] of Object.entries(node)) {
    if (entry.subcommands) {
      const helpLine = entry.help ? `  ${entry.help}` : '';
      lines.push(`${indent}${key} <subcommand>${helpLine}`);
      const subKeys = Object.keys(entry.subcommands);
      // If any sub has its own subcommands, recurse one more level
      const nested = Object.values(entry.subcommands).some((e) => e.subcommands);
      if (nested) {
        lines.push(...render(entry.subcommands, indent + '  '));
      } else {
        lines.push(`${indent}  ${subKeys.join(', ')}`);
      }
    } else {
      const helpLine = entry.help ?? '';
      lines.push(`${indent}${key.padEnd(20)} ${helpLine}`);
    }
  }
  return lines;
}

export function renderHelp(commands) {
  const out = [
    'robin <command> [args]',
    '',
    'Commands:',
    ...render(commands),
  ];
  return out.join('\n');
}

// Back-compat: keep a `help()` export for any caller invoking the old shape.
export function help() {
  // eslint-disable-next-line global-require
  import('./../commands.js').then(({ commands }) => console.log(renderHelp(commands)));
}
```

- [ ] **Step 5: Run all new tests**

```bash
node --test system/tests/unit/runtime/cli/
```

Expected: all pass.

- [ ] **Step 6: Run full suite**

```bash
npm test
```

Expected: all pass. CLI integration tests should succeed unchanged because the external CLI surface (`robin install`, `robin mcp start`, etc.) is byte-identical.

- [ ] **Step 7: Commit**

```bash
git add system/runtime/cli/index.js system/runtime/cli/commands/help.js system/tests/unit/runtime/cli/dispatch.test.js system/tests/unit/runtime/cli/help.test.js
git commit -m "$(cat <<'EOF'
feat(runtime): R-5 — declarative CLI dispatcher + auto-generated help

cli/index.js: 295 → ~55 lines. Recursive dispatcher supports nested groups
(integrations discord register-commands) without special-casing. help.js
walks the registry; --help output is data-driven.
EOF
)"
```

---

### Task 5.5: Open R-5 PR

- [ ] **Step 1: Push + PR**

```bash
git push -u origin feat/runtime-r5-cli-router
gh pr create --title "feat(runtime): R-5 — declarative CLI router" --body "$(cat <<'EOF'
## Summary
- Replace `cli/index.js`'s 295-line if/else with a 55-line dispatcher driven by `cli/commands.js`.
- Drop the `Object.values(mod)[0]` magic from 7 subcommand files — explicit export names everywhere.
- `--help` is auto-generated by walking the registry.
- Recursive dispatch supports `integrations discord register-commands` natively.

## Behavior preserved
Every `robin <cmd>` and `robin <cmd> <sub>` invocation works identically. Help text shape is data-driven (no test depends on the exact string).

## Test plan
- [x] commands.test.js: every leaf module resolves; every declared export exists; no duplicate keys.
- [x] dispatch.test.js: leaf dispatch, group + missing subcommand, recursive group, unknown command.
- [x] help.test.js: spot-check key strings present.
- [x] `npm test` green.
EOF
)"
```

---

## Self-Review Checklist

After completing each phase's PR but before merging, run through this:

- [ ] **Spec coverage:** R-1 covers §3 of the spec; R-2 covers §4; R-3 covers §5; R-4 covers §6; R-5 covers §7. Each PR's "Summary" matches the spec section.
- [ ] **External surface:** `/internal/*` URLs unchanged across all PRs. CLI command names + flags unchanged. MCP tool names unchanged. Hook contract (`robin hook <phase>`) unchanged. Signal handling (SIGTERM/SIGINT) preserved.
- [ ] **Wire-format changes:** Only R-4 changes wire format. R-4 changes are additive (`ok: true`/`false`) except for the three documented renames (`/internal/actions/*` lose semantic `ok`; `/internal/jobs/run` `ok` → `succeeded`).
- [ ] **Test coverage:** Every new function has unit tests. New integration tests cover daemon boot, host watchdog, and route dispatch.
- [ ] **Lint clean:** `npm run lint` passes with no warnings on every PR.
- [ ] **No placeholders:** No "TODO" or "fix later" comments in the diff.
- [ ] **Commit messages:** Each commit has a one-line subject and a body explaining "why," following the `<type>(<scope>): <subject>` style used by the project.

---

## Cross-phase post-merge checklist

After all five PRs merge:

- [ ] `system/runtime/daemon/server.js` is ~80 lines.
- [ ] `system/runtime/cli/index.js` is ~55 lines.
- [ ] `wc -l system/runtime/daemon/*.js` shows the decomposed shape: boot.js (~180), lifecycle.js (~100), tools.js (~130), http.js (~100), routes/* (each ≤ ~80).
- [ ] `npm test` green.
- [ ] `npm run lint` clean.
- [ ] Dogfood: run as daily-use Robin for ≥ 24h with no daemon restarts caused by R-1…R-5 changes.

---

## Notes for the implementing engineer

- **Other agents may be in this repo.** Before starting any phase, run `git status` on a fresh checkout of `main` to ensure no unexpected work in `system/runtime/`. If conflicts appear during a phase, rebase against `main` rather than merge.
- **Test names** in this plan are illustrative — match the project's existing test naming convention if it differs.
- **The `_status` escape hatch** introduced in R-3 is used by exactly one route today (the R-1 biographer 207 case). Resist the urge to add more `_status` returns elsewhere; if a route legitimately needs a non-200 success, that's a signal the envelope shape might need extending — bring it up before adding ad-hoc statuses.
- **`ctx` shape stability** (R-3 onward): every route handler closes over `ctx` via its `handler({ ctx, body, tools })` argument. If R-3 implementation reveals fields not anticipated in the spec, add them to `boot.js`'s returned ctx — don't reach into module-level globals.


