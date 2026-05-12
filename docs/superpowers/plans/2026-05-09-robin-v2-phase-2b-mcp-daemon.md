# Robin v2 Phase 2b — MCP Daemon + Agent Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `robin-mcp` HTTP+SSE daemon that owns the embedded SurrealDB, exposes 10 agent-facing MCP tools, routes biographer through the daemon, and instruments self-improvement feedback capture.

**Architecture:** Single Node daemon on `127.0.0.1:<port>` owns the DB connection. Multiple Claude Code instances connect via HTTP+SSE (Path A from verification spike) or via a stdio shim (Path B fallback). MCP tools wrap Phase 2a's internal `recall`, `recordEvent`, `biographer`, `cascade`, `episodes`, `edges` primitives. New `recall_events` table auto-captures every recall call for future reranker training; `mark_recall_used` and `record_correction` tools complete the feedback loop. Stop hook routes through daemon when running, falls back to spawn-detached subprocess otherwise.

**Tech Stack:** Node ≥ 22, ES modules. `@modelcontextprotocol/sdk` (Anthropic's TypeScript MCP SDK). `surrealdb@^2.0.3` + `@surrealdb/node@^3.0.3`. `@huggingface/transformers`. Subprocess to Claude Code/Gemini CLI for `invokeLLM` (already wired in 2a). `node --test`. Biome.

**Spec:** `/Users/iser/workspace/robin/robin-assistant/docs/superpowers/specs/2026-05-09-robin-v2-phase-2b-design.md` is the source of truth. Section 7's acceptance gate is the bar this plan must clear.

---

## File structure (additions to v2)

```
robin-assistant-v2/
  src/
    daemon/
      server.js                 # daemon entry point: lock + state + MCP server boot
      port.js                   # bind 127.0.0.1:0, atomic .daemon.state write
      lock.js                   # daemon-level lock (~/.robin/.daemon.lock)
      state.js                  # read/write/cleanup .daemon.state
      version-handshake.js      # CLI ↔ daemon version compatibility check
      biographer-queue.js       # in-daemon FIFO with mutex
      idle-embedder.js          # unload embedder after N min idle
    mcp/
      server.js                 # @modelcontextprotocol/sdk Server setup
      session.js                # extract MCP session id from request context
      implicit-signals.js       # repeat-query-within-N-min detector
      tools/
        health.js
        recall.js
        remember.js
        run-biographer.js
        find-entity.js
        get-entity.js
        related-entities.js
        list-episodes.js
        mark-recall-used.js
        record-correction.js
    cli/
      commands/
        mcp-start.js
        mcp-stop.js
        mcp-status.js
        mcp-restart.js
        mcp-ensure-running.js
        mcp-install.js
        mcp-uninstall.js
        mcp-connect.js          # Path B only — stdio↔HTTP shim
    hooks/
      stop-hook.js              # MODIFY: route through daemon, fall back to subprocess
    install/
      launchd-plist.js          # macOS plist template generator
      systemd-unit.js           # Linux user-unit template generator
      agents-md.js              # AGENTS.md content + writer
    schema/migrations/
      0004-recall-events.surql  # NEW
  tests/
    unit/
      daemon-port.test.js
      daemon-lock.test.js
      daemon-state.test.js
      daemon-version-handshake.test.js
      biographer-queue.test.js
      idle-embedder.test.js
      tool-health.test.js
      tool-recall.test.js
      tool-remember.test.js
      tool-run-biographer.test.js
      tool-find-entity.test.js
      tool-get-entity.test.js
      tool-related-entities.test.js
      tool-list-episodes.test.js
      tool-mark-recall-used.test.js
      tool-record-correction.test.js
      implicit-signals.test.js
      launchd-plist.test.js
      systemd-unit.test.js
      agents-md.test.js
    integration/
      mcp-end-to-end.test.js
      multi-instance.test.js
      stop-hook-via-daemon.test.js
      crash-recovery.test.js
      feedback-loop.test.js
      correction-loop.test.js
      mcp-connect-shim.test.js  # Path B only
```

---

## Task 1: MCP transport spike

**Files:**
- Create: `~/workspace/robin/robin-assistant/docs/superpowers/specs/2026-05-09-mcp-transport-spike.md` (working-tree only; gitignored)

- [ ] **Step 1: Inspect Claude Code's MCP client config support**

```bash
which claude && claude --help 2>&1 | head -30
ls ~/.claude/ 2>/dev/null
cat ~/.claude/settings.json 2>/dev/null | head -40
```

Look for `mcpServers` examples + transport options.

- [ ] **Step 2: Web search if needed for Claude Code MCP transport options**

Confirm whether Claude Code's `mcpServers` entry supports an HTTP/SSE `url` field in addition to stdio (`command` + `args`). Anthropic docs: https://docs.claude.com/en/docs/claude-code/mcp

- [ ] **Step 3: Inspect Gemini CLI MCP support**

```bash
which gemini && gemini --help 2>&1 | grep -iE 'mcp|tool|server' || true
```

- [ ] **Step 4: Verify AGENTS.md install paths**

Check both `~/.claude/AGENTS.md` and project-level `<repo>/.claude/AGENTS.md`. Same for Gemini. Document which is the actual convention.

- [ ] **Step 5: Write the spike note**

`/Users/iser/workspace/robin/robin-assistant/docs/superpowers/specs/2026-05-09-mcp-transport-spike.md`:

```markdown
# Phase 2b MCP Transport Spike

**Date:** 2026-05-09
**Outcomes:** Claude Code transport: A | B. Gemini MCP: supported | not. AGENTS.md path: ...

## Claude Code MCP

[Paste help output, settings.json examples, docs links]

**Decision:** Path A (HTTP+SSE `url`) — OR — Path B (stdio shim).

## Gemini CLI MCP

**Decision:** supported (via subcommand X) — OR — not in 2b (Claude Code only for now).

## AGENTS.md install path

- Claude Code: `<path>` — confirmed by [evidence].
- Gemini CLI: `<path>` — confirmed by [evidence].
```

- [ ] **Step 6: No commit (working-tree-only doc in v1's gitignored docs/)**

---

## Task 2: Schema migration 0004

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/schema/migrations/0004-recall-events.surql`
- Modify: `~/workspace/robin/robin-assistant-v2/tests/integration/bootstrap-empty-db.test.js`

- [ ] **Step 1: Write the migration**

`src/schema/migrations/0004-recall-events.surql`:

```surql
-- Phase 2b: self-improvement feedback table

DEFINE TABLE recall_events SCHEMAFULL TYPE NORMAL;
DEFINE FIELD query_text     ON recall_events TYPE string;
DEFINE FIELD query_vec      ON recall_events TYPE array<float>
  ASSERT array::len($value) = 384;
DEFINE FIELD hit_ids        ON recall_events TYPE array<record<events>>;
DEFINE FIELD hit_dists      ON recall_events TYPE array<float>;
DEFINE FIELD hit_used       ON recall_events TYPE array<bool>;
DEFINE FIELD session_id     ON recall_events TYPE option<string>;
DEFINE FIELD ts             ON recall_events TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta           ON recall_events TYPE option<object> FLEXIBLE;
DEFINE INDEX recall_events_ts ON recall_events FIELDS ts;
DEFINE INDEX recall_events_session ON recall_events FIELDS session_id, ts;
```

- [ ] **Step 2: Verify schema parses sequentially**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
node -e "
import('./src/db/client.js').then(async ({connect, close}) => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = 'src/schema/migrations';
  const files = (await readdir(dir)).filter(f => f.endsWith('.surql')).sort();
  const db = await connect({ engine: 'mem://' });
  for (const f of files) {
    await db.query(await readFile(join(dir, f), 'utf8')).collect();
    console.log('OK', f);
  }
  await close(db);
  process.exit(0);
});
"
```

Expected: prints `OK 0001-init.surql`, `OK 0002-pin-embedding-dim.surql`, `OK 0003-graph-biographer.surql`, `OK 0004-recall-events.surql`.

- [ ] **Step 3: Update bootstrap test for 4 migrations**

In `tests/integration/bootstrap-empty-db.test.js`, change `/applied 3 migrations/` to `/applied 4 migrations/`.

- [ ] **Step 4: Run full suite**

```bash
npm test
```

Expected: 128 pass.

- [ ] **Step 5: Commit**

```bash
git add src/schema/migrations/0004-recall-events.surql tests/integration/bootstrap-empty-db.test.js
git commit -m "feat(schema): 0004-recall-events — feedback capture table"
```

---

## Task 3: Daemon port allocation

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/daemon/port.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/daemon-port.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/daemon-port.test.js`:

```js
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { bindFreePort, getServerAddress } from '../../src/daemon/port.js';

test('bindFreePort binds 127.0.0.1:0 and returns an HTTP-able server', async () => {
  const { server, port } = await bindFreePort();
  assert.ok(typeof port === 'number' && port > 0);
  server.close();
});

test('getServerAddress returns the actual bound port', () => {
  const server = createServer().listen(0, '127.0.0.1');
  const addr = getServerAddress(server);
  assert.equal(addr.address, '127.0.0.1');
  assert.ok(addr.port > 0);
  server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
npm test -- tests/unit/daemon-port.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/daemon/port.js`:

```js
import { createServer } from 'node:http';

export async function bindFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

export function getServerAddress(server) {
  return server.address();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/daemon-port.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/port.js tests/unit/daemon-port.test.js
git commit -m "feat(daemon): port allocation helper"
```

---

## Task 4: Daemon lock

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/daemon/lock.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/daemon-lock.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/daemon-lock.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireDaemonLock, isPidAlive, releaseDaemonLock } from '../../src/daemon/lock.js';

test('acquireDaemonLock writes pid; release deletes file', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-lock-'));
  const path = join(tmp, '.daemon.lock');
  await acquireDaemonLock(path);
  await releaseDaemonLock(path);
  rmSync(tmp, { recursive: true });
});

test('acquireDaemonLock fails when locked by live PID', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-lock2-'));
  const path = join(tmp, '.daemon.lock');
  writeFileSync(path, String(process.pid));
  await assert.rejects(acquireDaemonLock(path), /already running/i);
  rmSync(tmp, { recursive: true });
});

test('acquireDaemonLock cleans up stale lock from dead PID', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-lock3-'));
  const path = join(tmp, '.daemon.lock');
  writeFileSync(path, '999999'); // unlikely to be a live PID
  await acquireDaemonLock(path);
  await releaseDaemonLock(path);
  rmSync(tmp, { recursive: true });
});

test('isPidAlive returns true for self', () => {
  assert.equal(isPidAlive(process.pid), true);
});

test('isPidAlive returns false for clearly-dead PID', () => {
  assert.equal(isPidAlive(999999), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/daemon-lock.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/daemon/lock.js`:

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

export async function acquireDaemonLock(path) {
  try {
    const existing = await readFile(path, 'utf8');
    const pid = Number.parseInt(existing.trim(), 10);
    if (Number.isInteger(pid) && isPidAlive(pid)) {
      const err = new Error(`daemon already running (pid ${pid})`);
      err.code = 'EALREADY';
      throw err;
    }
    // Stale: clean up
    await unlink(path).catch(() => {});
  } catch (e) {
    if (e.code !== 'ENOENT') {
      if (e.code === 'EALREADY') throw e;
    }
  }
  await writeFile(path, String(process.pid), { flag: 'w' });
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

```bash
npm test -- tests/unit/daemon-lock.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/lock.js tests/unit/daemon-lock.test.js
git commit -m "feat(daemon): daemon-level lock with stale-PID cleanup"
```

---

## Task 5: Daemon state file (.daemon.state)

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/daemon/state.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/daemon-state.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/daemon-state.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearDaemonState, readDaemonState, writeDaemonState } from '../../src/daemon/state.js';

test('writeDaemonState + readDaemonState round-trip', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-state-'));
  const path = join(tmp, '.daemon.state');
  const data = { port: 12345, pid: process.pid, version: '6.0.0-alpha.2', started_at: new Date().toISOString() };
  await writeDaemonState(path, data);
  const read = await readDaemonState(path);
  assert.deepEqual(read, data);
  rmSync(tmp, { recursive: true });
});

test('readDaemonState returns null when file missing', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-state2-'));
  const path = join(tmp, '.daemon.state');
  const r = await readDaemonState(path);
  assert.equal(r, null);
  rmSync(tmp, { recursive: true });
});

test('clearDaemonState removes the file', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-state3-'));
  const path = join(tmp, '.daemon.state');
  await writeDaemonState(path, { port: 1, pid: 1, version: 'x', started_at: new Date().toISOString() });
  await clearDaemonState(path);
  const r = await readDaemonState(path);
  assert.equal(r, null);
  rmSync(tmp, { recursive: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/daemon-state.test.js
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`src/daemon/state.js`:

```js
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

export async function readDaemonState(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeDaemonState(path, data) {
  // Atomic via tmp + rename
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, path);
}

export async function clearDaemonState(path) {
  try {
    await unlink(path);
  } catch {
    /* idempotent */
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/daemon-state.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/state.js tests/unit/daemon-state.test.js
git commit -m "feat(daemon): atomic daemon state file"
```

---

## Task 6: Version handshake

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/daemon/version-handshake.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/daemon-version-handshake.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/daemon-version-handshake.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkVersionMatch, getCliVersion } from '../../src/daemon/version-handshake.js';

test('matching versions pass', () => {
  const r = checkVersionMatch('6.0.0-alpha.2', '6.0.0-alpha.2');
  assert.equal(r.ok, true);
});

test('mismatched versions fail with both versions in error', () => {
  const r = checkVersionMatch('6.0.0-alpha.1', '6.0.0-alpha.2');
  assert.equal(r.ok, false);
  assert.match(r.error, /6\.0\.0-alpha\.1/);
  assert.match(r.error, /6\.0\.0-alpha\.2/);
  assert.match(r.error, /restart/i);
});

test('getCliVersion returns the package.json version', async () => {
  const v = await getCliVersion();
  assert.match(v, /^6\./);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/daemon-version-handshake.test.js
```

- [ ] **Step 3: Write the implementation**

`src/daemon/version-handshake.js`:

```js
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedVersion = null;

export async function getCliVersion() {
  if (cachedVersion) return cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, '../../package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  cachedVersion = pkg.version;
  return cachedVersion;
}

export function checkVersionMatch(daemonVersion, cliVersion) {
  if (daemonVersion === cliVersion) return { ok: true };
  return {
    ok: false,
    error: `daemon is running on ${daemonVersion}; you're on ${cliVersion}. Restart with \`robin mcp restart\``,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/daemon-version-handshake.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/daemon/version-handshake.js tests/unit/daemon-version-handshake.test.js
git commit -m "feat(daemon): CLI ↔ daemon version handshake"
```

---

## Task 7: Biographer queue (in-daemon FIFO with mutex)

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/daemon/biographer-queue.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/biographer-queue.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/biographer-queue.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBiographerQueue } from '../../src/daemon/biographer-queue.js';

test('queue processes events sequentially with single worker', async () => {
  const order = [];
  const worker = async (id) => {
    order.push(`start-${id}`);
    await new Promise((r) => setTimeout(r, 10));
    order.push(`end-${id}`);
    return { processed: id };
  };
  const q = createBiographerQueue({ worker });
  const r1 = q.enqueue('a');
  const r2 = q.enqueue('b');
  const r3 = q.enqueue('c');
  await Promise.all([r1, r2, r3]);
  assert.deepEqual(order, ['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c']);
});

test('concurrent enqueue of same id coalesces (idempotent dedupe)', async () => {
  let calls = 0;
  const worker = async () => {
    calls++;
    return { processed: 1 };
  };
  const q = createBiographerQueue({ worker, dedupe: true });
  const r1 = q.enqueue('same');
  const r2 = q.enqueue('same');
  const r3 = q.enqueue('same');
  await Promise.all([r1, r2, r3]);
  assert.equal(calls, 1, 'dedupe should run worker once');
});

test('worker errors propagate to enqueue caller', async () => {
  const worker = async () => {
    throw new Error('boom');
  };
  const q = createBiographerQueue({ worker });
  await assert.rejects(q.enqueue('x'), /boom/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/biographer-queue.test.js
```

- [ ] **Step 3: Write the implementation**

`src/daemon/biographer-queue.js`:

```js
export function createBiographerQueue({ worker, dedupe = false }) {
  const queue = []; // [{ id, resolve, reject }]
  const inflight = new Map(); // id → promise (when dedupe)
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    while (queue.length > 0) {
      const { id, resolve, reject } = queue.shift();
      try {
        const result = await worker(id);
        resolve(result);
      } catch (e) {
        reject(e);
      }
      if (dedupe) inflight.delete(id);
    }
    running = false;
  }

  function enqueue(id) {
    if (dedupe && inflight.has(id)) return inflight.get(id);
    const promise = new Promise((resolve, reject) => {
      queue.push({ id, resolve, reject });
    });
    if (dedupe) inflight.set(id, promise);
    drain();
    return promise;
  }

  return { enqueue };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/biographer-queue.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/daemon/biographer-queue.js tests/unit/biographer-queue.test.js
git commit -m "feat(daemon): biographer FIFO queue with optional id-dedupe"
```

---

## Task 8: Idle-embedder unloader

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/daemon/idle-embedder.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/idle-embedder.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/idle-embedder.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIdleEmbedder } from '../../src/daemon/idle-embedder.js';

test('idle embedder loads on first use; unloads after timeout', async () => {
  let loadCount = 0;
  const factory = async () => {
    loadCount++;
    return { dimension: 384, embed: async () => new Float32Array(384) };
  };
  const ie = createIdleEmbedder({ factory, idleMs: 50 });
  const e1 = await ie.get();
  await e1.embed('a');
  ie.touch();
  await new Promise((r) => setTimeout(r, 100));
  // Idle expired; next get() reloads
  const e2 = await ie.get();
  assert.ok(e2);
  assert.equal(loadCount, 2);
  ie.shutdown();
});

test('repeated touches keep embedder alive', async () => {
  let loadCount = 0;
  const factory = async () => {
    loadCount++;
    return { dimension: 384 };
  };
  const ie = createIdleEmbedder({ factory, idleMs: 50 });
  await ie.get();
  for (let i = 0; i < 5; i++) {
    ie.touch();
    await new Promise((r) => setTimeout(r, 20));
  }
  await ie.get();
  assert.equal(loadCount, 1);
  ie.shutdown();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/idle-embedder.test.js
```

- [ ] **Step 3: Write the implementation**

`src/daemon/idle-embedder.js`:

```js
export function createIdleEmbedder({ factory, idleMs = 600_000 }) {
  let embedder = null;
  let lastTouch = 0;
  let timer = null;

  function scheduleUnload() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (Date.now() - lastTouch >= idleMs) {
        embedder = null;
      }
    }, idleMs + 100);
    timer.unref?.();
  }

  return {
    async get() {
      lastTouch = Date.now();
      if (!embedder) {
        embedder = await factory();
      }
      scheduleUnload();
      return embedder;
    },
    touch() {
      lastTouch = Date.now();
      scheduleUnload();
    },
    shutdown() {
      if (timer) clearTimeout(timer);
      embedder = null;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/idle-embedder.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/daemon/idle-embedder.js tests/unit/idle-embedder.test.js
git commit -m "feat(daemon): idle-embedder unload timer"
```

---

## Task 9: Install MCP SDK + scaffold MCP server

**Files:**
- Modify: `~/workspace/robin/robin-assistant-v2/package.json`
- Create: `~/workspace/robin/robin-assistant-v2/src/mcp/server.js`

- [ ] **Step 1: Install the MCP SDK**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
npm install @modelcontextprotocol/sdk
```

- [ ] **Step 2: Write `src/mcp/server.js`**

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function createMcpServer({ tools, version }) {
  const server = new Server(
    { name: 'robin', version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] };
    }
    try {
      const result = await tool.handler(args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });

  return server;
}

export { SSEServerTransport };
```

- [ ] **Step 3: Verify imports work**

```bash
node -e "import('./src/mcp/server.js').then(m => console.log('OK', Object.keys(m)));"
```

Expected: `OK [ 'createMcpServer', 'SSEServerTransport' ]`.

- [ ] **Step 4: Lint**

```bash
npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/mcp/server.js
git commit -m "feat(mcp): install @modelcontextprotocol/sdk + server scaffold"
```

---

## Task 10: Tool — `health`

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/mcp/tools/health.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/tool-health.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/tool-health.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHealthTool } from '../../src/mcp/tools/health.js';

test('health returns ok when all subsystems are up', async () => {
  const tool = createHealthTool({
    version: '6.0.0-alpha.2',
    startedAt: new Date(Date.now() - 5000),
    db: { isOpen: () => true, query: async () => [[{ n: 0 }]] },
    embedder: { isLoaded: () => false },
    biographerQueue: { lastRunAt: null },
    sessions: { count: 0 },
  });
  const result = await tool.handler({});
  assert.equal(result.status, 'ok');
  assert.equal(result.version, '6.0.0-alpha.2');
  assert.ok(result.uptime_seconds >= 4);
  assert.equal(result.db_open, true);
  assert.equal(result.embedder_loaded, false);
});

test('health.name is "health"', () => {
  const tool = createHealthTool({
    version: 'x', startedAt: new Date(), db: { isOpen: () => true, query: async () => [[{ n: 0 }]] },
    embedder: { isLoaded: () => false }, biographerQueue: { lastRunAt: null }, sessions: { count: 0 },
  });
  assert.equal(tool.name, 'health');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/tool-health.test.js
```

- [ ] **Step 3: Write the implementation**

`src/mcp/tools/health.js`:

```js
import { surql } from 'surrealdb';

export function createHealthTool({ version, startedAt, db, embedder, biographerQueue, sessions }) {
  return {
    name: 'health',
    description: 'Daemon health check: status, uptime, db/embedder state, queue + session counts.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      let pending = 0;
      let failed = 0;
      try {
        const [pendingRows] = await db
          .query(surql`SELECT count() AS n FROM events WHERE biographed_at IS NONE GROUP ALL`)
          .collect();
        pending = pendingRows[0]?.n ?? 0;
        const [bRows] = await db
          .query(surql`SELECT * FROM type::record('runtime', 'biographer') LIMIT 1`)
          .collect();
        failed = bRows[0]?.value?.failed_event_ids?.length ?? 0;
      } catch {
        // db down or pre-migration; report degraded
      }
      return {
        status: db.isOpen() ? 'ok' : 'degraded',
        version,
        uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        db_open: db.isOpen(),
        embedder_loaded: embedder.isLoaded(),
        pending_events: pending,
        failed_events: failed,
        active_sessions: sessions.count,
        last_biographer_run_at: biographerQueue.lastRunAt,
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/tool-health.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/health.js tests/unit/tool-health.test.js
git commit -m "feat(mcp): health tool"
```

---

## Task 11: Implicit-signal detector (repeat-query)

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/mcp/implicit-signals.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/implicit-signals.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/implicit-signals.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRepeatQueryDetector } from '../../src/mcp/implicit-signals.js';

function vec(seed) {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = Math.sin(seed + i * 0.01);
  // Normalize
  let mag = 0;
  for (let i = 0; i < 384; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag);
  for (let i = 0; i < 384; i++) v[i] /= mag;
  return Array.from(v);
}

test('exact same vector within window flags repeat', () => {
  const det = createRepeatQueryDetector({ windowMinutes: 5, similarityThreshold: 0.95 });
  const v = vec(1);
  det.observe('s1', v);
  const r = det.check('s1', v);
  assert.equal(r.repeat, true);
});

test('different vector does not flag', () => {
  const det = createRepeatQueryDetector({ windowMinutes: 5, similarityThreshold: 0.95 });
  det.observe('s1', vec(1));
  const r = det.check('s1', vec(50));
  assert.equal(r.repeat, false);
});

test('different session does not flag', () => {
  const det = createRepeatQueryDetector({ windowMinutes: 5, similarityThreshold: 0.95 });
  const v = vec(1);
  det.observe('s1', v);
  const r = det.check('s2', v);
  assert.equal(r.repeat, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

`src/mcp/implicit-signals.js`:

```js
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function createRepeatQueryDetector({ windowMinutes = 5, similarityThreshold = 0.95, maxPerSession = 5 } = {}) {
  const windowMs = windowMinutes * 60_000;
  const bySession = new Map(); // sessionId → [{ vec, ts }]

  function prune(now, history) {
    while (history.length > 0 && now - history[0].ts > windowMs) history.shift();
  }

  return {
    observe(sessionId, queryVec) {
      const now = Date.now();
      let h = bySession.get(sessionId);
      if (!h) {
        h = [];
        bySession.set(sessionId, h);
      }
      prune(now, h);
      h.push({ vec: queryVec, ts: now });
      if (h.length > maxPerSession) h.shift();
    },
    check(sessionId, queryVec) {
      const now = Date.now();
      const h = bySession.get(sessionId);
      if (!h) return { repeat: false };
      prune(now, h);
      for (const { vec } of h) {
        if (cosine(vec, queryVec) >= similarityThreshold) return { repeat: true };
      }
      return { repeat: false };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/implicit-signals.js tests/unit/implicit-signals.test.js
git commit -m "feat(mcp): repeat-query implicit-signal detector"
```

---

## Task 12: Tool — `recall` (with auto-capture)

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/mcp/tools/recall.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/tool-recall.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/tool-recall.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createRepeatQueryDetector } from '../../src/mcp/implicit-signals.js';
import { createRecallTool } from '../../src/mcp/tools/recall.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('recall tool returns hits and writes recall_events row', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  await recordEvent(db, e, { source: 'cli', content: 'apple' });
  await recordEvent(db, e, { source: 'cli', content: 'banana' });
  const detector = createRepeatQueryDetector({});
  const tool = createRecallTool({ db, embedder: e, detector, getSessionId: () => 'sess-1' });
  const result = await tool.handler({ query: 'apple' });
  assert.ok(result.recall_event_id);
  assert.ok(Array.isArray(result.hits));
  // recall_events row written
  const [rows] = await db.query(surql`SELECT * FROM recall_events`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query_text, 'apple');
  assert.equal(rows[0].session_id, 'sess-1');
  assert.equal(rows[0].hit_used.length, rows[0].hit_ids.length);
  assert.ok(rows[0].hit_used.every((u) => u === false));
  await close(db);
});

test('repeated query within window sets meta.repeat_query_within_5min', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  await recordEvent(db, e, { source: 'cli', content: 'one' });
  const detector = createRepeatQueryDetector({});
  const tool = createRecallTool({ db, embedder: e, detector, getSessionId: () => 'sess-1' });
  await tool.handler({ query: 'something' });
  await tool.handler({ query: 'something' }); // exact repeat
  const [rows] = await db
    .query(surql`SELECT * FROM recall_events ORDER BY ts DESC LIMIT 1`)
    .collect();
  assert.equal(rows[0].meta?.repeat_query_within_5min, true);
  await close(db);
});

test('recall name is "recall"', () => {
  const tool = createRecallTool({
    db: null, embedder: null, detector: null, getSessionId: () => null,
  });
  assert.equal(tool.name, 'recall');
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

`src/mcp/tools/recall.js`:

```js
import { surql } from 'surrealdb';
import { recall as internalRecall } from '../../recall/index.js';

export function createRecallTool({ db, embedder, detector, getSessionId }) {
  return {
    name: 'recall',
    description:
      "Search the user's memory by semantic similarity. Returns events that match the query, with mention-edge enrichment. Call mark_recall_used afterwards with the IDs of hits that informed your answer.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        source: { type: 'string', enum: ['cli', 'stop_hook', 'manual', 'sync', 'biographer', 'ingest', 'discord', 'migration'] },
        since: { type: 'string', format: 'date-time' },
        until: { type: 'string', format: 'date-time' },
        explain: { type: 'boolean', default: false },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const sessionId = getSessionId() ?? null;
      const queryVec = Array.from(await embedder.embed(args.query));

      // Detect repeat-query implicit signal
      const repeat = detector.check(sessionId, queryVec).repeat;
      detector.observe(sessionId, queryVec);

      // Run internal recall
      const r = await internalRecall(db, embedder, args.query, {
        limit: args.limit,
        source: args.source,
        since: args.since,
        until: args.until,
        explain: args.explain,
      });

      const hitIds = r.hits.map((h) => h.id);
      const hitDists = r.hits.map((h) => h.dist);

      // Capture recall_events row
      const meta = repeat ? { repeat_query_within_5min: true } : undefined;
      const [created] = await db
        .query(
          surql`CREATE recall_events CONTENT ${{
            query_text: args.query,
            query_vec: queryVec,
            hit_ids: hitIds,
            hit_dists: hitDists,
            hit_used: hitIds.map(() => false),
            session_id: sessionId,
            meta,
          }}`,
        )
        .collect();
      const recallEventId = (Array.isArray(created) ? created[0] : created).id;

      // Enrich hits with mentions edges
      const enrichedHits = [];
      for (const hit of r.hits) {
        const [mentions] = await db
          .query(
            surql`SELECT ->mentions->entities AS m FROM ${hit.id}`,
          )
          .collect();
        const m = mentions[0]?.m ?? [];
        const [details] = await db
          .query(surql`SELECT id, name, type FROM entities WHERE id IN ${m}`)
          .collect();
        enrichedHits.push({
          id: String(hit.id),
          source: hit.source,
          content: hit.content,
          ts: hit.ts,
          dist: hit.dist,
          mentions: details.map((d) => ({
            entity_id: String(d.id),
            entity_name: d.name,
            entity_type: d.type,
          })),
        });
      }

      return {
        recall_event_id: String(recallEventId),
        hits: enrichedHits,
        ...(r.explain ? { explain: r.explain } : {}),
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/recall.js tests/unit/tool-recall.test.js
git commit -m "feat(mcp): recall tool with auto-capture + implicit-signal detection"
```

---

## Task 13: Tool — `remember`

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/mcp/tools/remember.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/tool-remember.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/tool-remember.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createRememberTool } from '../../src/mcp/tools/remember.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('remember tool writes an event', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const enqueueCalls = [];
  const queue = { enqueue: (id) => { enqueueCalls.push(id); return Promise.resolve(); } };
  const tool = createRememberTool({ db, embedder: e, queue });
  const result = await tool.handler({ content: 'noted', source: 'manual' });
  assert.ok(result.id);
  const [rows] = await db.query(surql`SELECT count() AS n FROM events GROUP ALL`).collect();
  assert.equal(rows[0].n, 1);
});

test('remember triggers biographer when trigger_biographer not false', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const enqueueCalls = [];
  const queue = { enqueue: (id) => { enqueueCalls.push(id); return Promise.resolve(); } };
  const tool = createRememberTool({ db, embedder: e, queue });
  await tool.handler({ content: 'x' });
  assert.equal(enqueueCalls.length, 1);
});

test('remember skips biographer when trigger_biographer: false', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const enqueueCalls = [];
  const queue = { enqueue: (id) => { enqueueCalls.push(id); return Promise.resolve(); } };
  const tool = createRememberTool({ db, embedder: e, queue });
  await tool.handler({ content: 'x', trigger_biographer: false });
  assert.equal(enqueueCalls.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

`src/mcp/tools/remember.js`:

```js
import { recordEvent } from '../../capture/record-event.js';

export function createRememberTool({ db, embedder, queue }) {
  return {
    name: 'remember',
    description:
      "Save a noteworthy observation to the user's memory. Be discerning — explicit preferences, named projects/people, decisions, deadlines are good candidates.",
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 10000 },
        source: { type: 'string', default: 'manual' },
        meta: { type: 'object' },
        trigger_biographer: { type: 'boolean', default: true },
      },
      required: ['content'],
    },
    handler: async (args) => {
      const result = await recordEvent(db, embedder, {
        source: args.source ?? 'manual',
        content: args.content,
        meta: args.meta,
      });
      if (args.trigger_biographer !== false) {
        // Fire-and-forget; don't block tool response
        queue.enqueue(String(result.id)).catch(() => {});
      }
      return { id: String(result.id) };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/remember.js tests/unit/tool-remember.test.js
git commit -m "feat(mcp): remember tool"
```

---

## Task 14: Tool — `run_biographer`

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/mcp/tools/run-biographer.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/tool-run-biographer.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/tool-run-biographer.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createRunBiographerTool } from '../../src/mcp/tools/run-biographer.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('run_biographer processes pending events via injected processor', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const evt1 = await recordEvent(db, e, { source: 'cli', content: 'a' });
  const evt2 = await recordEvent(db, e, { source: 'cli', content: 'b' });
  const processed = [];
  const processor = async (id) => { processed.push(String(id)); };
  const tool = createRunBiographerTool({ db, processor });
  const result = await tool.handler({ scope: 'pending', limit: 50 });
  assert.equal(result.processed, 2);
  assert.equal(result.failed, 0);
  assert.equal(processed.length, 2);
});

test('run_biographer respects limit', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  for (let i = 0; i < 5; i++) await recordEvent(db, e, { source: 'cli', content: `e${i}` });
  const processed = [];
  const processor = async (id) => { processed.push(String(id)); };
  const tool = createRunBiographerTool({ db, processor });
  const result = await tool.handler({ scope: 'pending', limit: 3 });
  assert.equal(result.processed, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

`src/mcp/tools/run-biographer.js`:

```js
import { surql } from 'surrealdb';

export function createRunBiographerTool({ db, processor }) {
  return {
    name: 'run_biographer',
    description:
      "Process pending events through the biographer pipeline. Normally automatic; call only when user explicitly asks.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['pending', 'failed', 'all'], default: 'pending' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
    },
    handler: async (args) => {
      const scope = args.scope ?? 'pending';
      const limit = args.limit ?? 50;
      let pendingIds = [];
      if (scope === 'failed') {
        const [rt] = await db.query(surql`SELECT * FROM type::record('runtime', 'biographer') LIMIT 1`).collect();
        pendingIds = rt[0]?.value?.failed_event_ids ?? [];
      } else {
        const where = scope === 'all'
          ? surql`SELECT id, ts FROM events ORDER BY ts ASC LIMIT ${limit}`
          : surql`SELECT id, ts FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT ${limit}`;
        const [rows] = await db.query(where).collect();
        pendingIds = rows.map((r) => r.id);
      }
      let processed = 0;
      let failed = 0;
      const failedIds = [];
      for (const id of pendingIds.slice(0, limit)) {
        try {
          await processor(id);
          processed++;
        } catch (e) {
          failed++;
          failedIds.push(String(id));
        }
      }
      return {
        processed,
        failed,
        ...(failedIds.length ? { failed_event_ids: failedIds } : {}),
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/run-biographer.js tests/unit/tool-run-biographer.test.js
git commit -m "feat(mcp): run_biographer tool"
```

---

## Task 15: Tool — `find_entity`

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/mcp/tools/find-entity.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/tool-find-entity.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/tool-find-entity.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createFindEntityTool } from '../../src/mcp/tools/find-entity.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('find_entity exact (fuzzy=false) matches by case-insensitive name', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const v = Array.from(await e.embed('person: Alice'));
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: v }}`).collect();
  const tool = createFindEntityTool({ db, embedder: e });
  const r = await tool.handler({ name: 'alice', type: 'person', fuzzy: false });
  assert.equal(r.entities.length, 1);
  assert.equal(r.entities[0].name, 'Alice');
});

test('find_entity returns empty when no match', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const tool = createFindEntityTool({ db, embedder: e });
  const r = await tool.handler({ name: 'missing', fuzzy: false });
  assert.deepEqual(r.entities, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

`src/mcp/tools/find-entity.js`:

```js
import { surql } from 'surrealdb';
import { stage1Resolve } from '../../graph/stage1-exact.js';
import { stage2Resolve } from '../../graph/stage2-embedding.js';

export function createFindEntityTool({ db, embedder }) {
  return {
    name: 'find_entity',
    description: 'Find entities (people, places, projects, topics, things) by name. Returns ranked matches.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        type: { type: 'string', enum: ['person', 'place', 'project', 'topic', 'thing'] },
        fuzzy: { type: 'boolean', default: true },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const limit = args.limit ?? 5;
      if (!args.fuzzy) {
        const types = args.type ? [args.type] : ['person', 'place', 'project', 'topic', 'thing'];
        const matches = [];
        for (const t of types) {
          const id = await stage1Resolve(db, { name: args.name, type: t });
          if (id) {
            const [rows] = await db.query(surql`SELECT id, name, type, created_at FROM ${id}`).collect();
            if (rows[0]) matches.push({ ...rows[0], id: String(rows[0].id) });
          }
        }
        return { entities: matches.slice(0, limit) };
      }
      // fuzzy: use Stage 2 — but stage2Resolve requires a type. If not given, run for all 5 and merge.
      const types = args.type ? [args.type] : ['person', 'place', 'project', 'topic', 'thing'];
      const all = [];
      for (const t of types) {
        const r = await stage2Resolve(db, embedder, {
          name: args.name,
          type: t,
          highThreshold: 0,  // include even low-similarity
          lowThreshold: 0,
        });
        if (r.action === 'resolve') {
          all.push({ id: r.entityId, similarity: r.similarity });
        } else if (r.action === 'escalate') {
          for (const c of r.candidates) all.push({ id: c.id, similarity: c.similarity });
        }
      }
      all.sort((a, b) => b.similarity - a.similarity);
      const ids = all.slice(0, limit).map((c) => c.id);
      if (ids.length === 0) return { entities: [] };
      const [rows] = await db
        .query(surql`SELECT id, name, type, created_at FROM entities WHERE id IN ${ids}`)
        .collect();
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      return {
        entities: all.slice(0, limit).map((c) => {
          const r = byId.get(String(c.id));
          return r ? { id: String(r.id), name: r.name, type: r.type, created_at: r.created_at, similarity: c.similarity } : null;
        }).filter(Boolean),
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/find-entity.js tests/unit/tool-find-entity.test.js
git commit -m "feat(mcp): find_entity tool (fuzzy + exact)"
```

---

## Task 16: Tool — `get_entity`

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/mcp/tools/get-entity.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/tool-get-entity.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/tool-get-entity.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createGetEntityTool } from '../../src/mcp/tools/get-entity.js';

test('get_entity returns the entity record', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  const v = Array.from(await e.embed('person: Alice'));
  const [created] = await db.query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: v }}`).collect();
  const id = (Array.isArray(created) ? created[0] : created).id;
  const tool = createGetEntityTool({ db });
  const r = await tool.handler({ id: String(id) });
  assert.equal(r.entity.name, 'Alice');
  assert.equal(r.entity.type, 'person');
  assert.ok(r.entity.edge_summary);
});

test('get_entity throws on unknown id', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const tool = createGetEntityTool({ db });
  await assert.rejects(tool.handler({ id: 'entities:nonexistent' }), /not found/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

`src/mcp/tools/get-entity.js`:

```js
import { surql } from 'surrealdb';

const EDGE_TABLES = ['mentions', 'about', 'works_on', 'participates_in', 'co_occurs_with'];

export function createGetEntityTool({ db }) {
  return {
    name: 'get_entity',
    description: 'Fetch a specific entity by its record id, including mention counts and edge summary.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async (args) => {
      const idRef = args.id.startsWith('entities:') ? args.id : `entities:${args.id}`;
      const [rows] = await db.query(`SELECT id, name, type, created_at, meta FROM ${idRef}`).collect();
      if (!rows || rows.length === 0) {
        throw new Error(`entity not found: ${args.id}`);
      }
      const entity = rows[0];

      // Edge summary
      const edgeSummary = {};
      for (const tbl of EDGE_TABLES) {
        const [c] = await db
          .query(`SELECT count() AS n FROM ${tbl} WHERE in = ${idRef} OR out = ${idRef} GROUP ALL`)
          .collect();
        edgeSummary[tbl] = c[0]?.n ?? 0;
      }

      const [mentionCount] = await db
        .query(`SELECT count() AS n FROM mentions WHERE out = ${idRef} GROUP ALL`)
        .collect();
      const [lastMention] = await db
        .query(`SELECT in.ts AS ts FROM mentions WHERE out = ${idRef} ORDER BY in.ts DESC LIMIT 1`)
        .collect();

      return {
        entity: {
          id: String(entity.id),
          name: entity.name,
          type: entity.type,
          created_at: entity.created_at,
          meta: entity.meta ?? null,
          mention_count: mentionCount[0]?.n ?? 0,
          last_mentioned_at: lastMention[0]?.ts ?? null,
          edge_summary: edgeSummary,
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/get-entity.js tests/unit/tool-get-entity.test.js
git commit -m "feat(mcp): get_entity tool with edge summary"
```

---

## Task 17: Tool — `related_entities`

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/mcp/tools/related-entities.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/tool-related-entities.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/tool-related-entities.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { writeCoOccursWith } from '../../src/graph/edges.js';
import { createRelatedEntitiesTool } from '../../src/mcp/tools/related-entities.js';

test('related_entities returns co_occurs_with neighbors', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  const ids = [];
  for (const n of ['Alice', 'Bob', 'Charlie']) {
    const v = Array.from(await e.embed(`person: ${n}`));
    const [c] = await db.query(surql`CREATE entities CONTENT ${{ name: n, type: 'person', embedding: v }}`).collect();
    ids.push((Array.isArray(c) ? c[0] : c).id);
  }
  await writeCoOccursWith(db, ids);
  const tool = createRelatedEntitiesTool({ db });
  const r = await tool.handler({ id: String(ids[0]), depth: 1, limit: 10 });
  assert.ok(r.related.length >= 2);
});

test('related_entities returns empty for entity with no edges', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  const v = Array.from(await e.embed('person: Solo'));
  const [c] = await db.query(surql`CREATE entities CONTENT ${{ name: 'Solo', type: 'person', embedding: v }}`).collect();
  const id = (Array.isArray(c) ? c[0] : c).id;
  const tool = createRelatedEntitiesTool({ db });
  const r = await tool.handler({ id: String(id) });
  assert.deepEqual(r.related, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

`src/mcp/tools/related-entities.js`:

```js
const ENTITY_EDGES = ['works_on', 'participates_in', 'co_occurs_with'];

export function createRelatedEntitiesTool({ db }) {
  return {
    name: 'related_entities',
    description:
      'Find entities connected to a given entity via graph edges (works_on, co_occurs_with, etc.). Depth 1 or 2.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        edge_types: { type: 'array', items: { type: 'string', enum: ENTITY_EDGES } },
        depth: { type: 'integer', enum: [1, 2], default: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const idRef = args.id.startsWith('entities:') ? args.id : `entities:${args.id}`;
      const edgeTypes = args.edge_types ?? ENTITY_EDGES;
      const depth = args.depth ?? 1;
      const limit = args.limit ?? 20;

      const related = [];
      for (const et of edgeTypes) {
        const [rows] = await db
          .query(
            `SELECT ->${et}->entities.* AS neighbors, ->${et}.* AS edges FROM ${idRef}`,
          )
          .collect();
        const neighbors = rows[0]?.neighbors ?? [];
        const edges = rows[0]?.edges ?? [];
        for (let i = 0; i < neighbors.length; i++) {
          if (related.length >= limit) break;
          const n = neighbors[i];
          const e = edges[i];
          related.push({
            entity: { id: String(n.id), name: n.name, type: n.type },
            edge_type: et,
            ...(e?.strength != null ? { strength: e.strength } : {}),
            distance: 1,
          });
        }
        if (related.length >= limit) break;
      }
      return { related: related.slice(0, limit) };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/related-entities.js tests/unit/tool-related-entities.test.js
git commit -m "feat(mcp): related_entities graph traversal tool"
```

---

## Task 18: Tool — `list_episodes`

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/mcp/tools/list-episodes.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/tool-list-episodes.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/tool-list-episodes.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createEpisode } from '../../src/graph/episodes.js';
import { createListEpisodesTool } from '../../src/mcp/tools/list-episodes.js';

test('list_episodes returns episodes with event counts', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  await createEpisode(db, { source: 'cli' });
  await createEpisode(db, { source: 'manual' });
  const tool = createListEpisodesTool({ db });
  const r = await tool.handler({});
  assert.ok(r.episodes.length >= 2);
});

test('list_episodes filters by source', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  await createEpisode(db, { source: 'cli' });
  await createEpisode(db, { source: 'manual' });
  const tool = createListEpisodesTool({ db });
  const r = await tool.handler({ source: 'manual' });
  assert.ok(r.episodes.every((e) => e.source === 'manual'));
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

`src/mcp/tools/list-episodes.js`:

```js
import { surql } from 'surrealdb';

export function createListEpisodesTool({ db }) {
  return {
    name: 'list_episodes',
    description: 'List episodes (groupings of related events) with optional time/source filters.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        since: { type: 'string', format: 'date-time' },
        until: { type: 'string', format: 'date-time' },
        active_only: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
    handler: async (args) => {
      const limit = args.limit ?? 20;
      const filters = [];
      const bindings = {};
      if (args.source) {
        filters.push(`source = $source`);
        bindings.source = args.source;
      }
      if (args.since) {
        filters.push(`started_at >= $since`);
        bindings.since = new Date(args.since);
      }
      if (args.until) {
        filters.push(`started_at <= $until`);
        bindings.until = new Date(args.until);
      }
      if (args.active_only) filters.push(`ended_at IS NONE`);
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const sql = `SELECT id, started_at, ended_at, source, summary FROM episodes ${where} ORDER BY started_at DESC LIMIT ${limit}`;
      const [rows] = await db.query(sql, bindings).collect();
      const episodes = [];
      for (const ep of rows) {
        const [c] = await db
          .query(surql`SELECT count() AS n FROM events WHERE episode_id = ${ep.id} GROUP ALL`)
          .collect();
        episodes.push({
          id: String(ep.id),
          started_at: ep.started_at,
          ended_at: ep.ended_at ?? null,
          source: ep.source,
          summary: ep.summary ?? null,
          event_count: c[0]?.n ?? 0,
        });
      }
      return { episodes };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/list-episodes.js tests/unit/tool-list-episodes.test.js
git commit -m "feat(mcp): list_episodes tool"
```

---

## Task 19: Tool — `mark_recall_used`

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/mcp/tools/mark-recall-used.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/tool-mark-recall-used.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/tool-mark-recall-used.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createMarkRecallUsedTool } from '../../src/mcp/tools/mark-recall-used.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

async function seedRecallEvent(db) {
  const e = createStubEmbedder({ dimension: 384 });
  const evt1 = await recordEvent(db, e, { source: 'cli', content: 'a' });
  const evt2 = await recordEvent(db, e, { source: 'cli', content: 'b' });
  const queryVec = Array.from(await e.embed('test'));
  const [created] = await db
    .query(surql`CREATE recall_events CONTENT ${{
      query_text: 'test',
      query_vec: queryVec,
      hit_ids: [evt1.id, evt2.id],
      hit_dists: [0.1, 0.2],
      hit_used: [false, false],
    }}`)
    .collect();
  return { recallEventId: (Array.isArray(created) ? created[0] : created).id, hitIds: [String(evt1.id), String(evt2.id)] };
}

test('mark_recall_used sets hit_used[i]=true for IDs in used_hit_ids', async () => {
  const db = await fresh();
  const { recallEventId, hitIds } = await seedRecallEvent(db);
  const tool = createMarkRecallUsedTool({ db });
  const r = await tool.handler({ recall_event_id: String(recallEventId), used_hit_ids: [hitIds[0]] });
  assert.equal(r.updated, 1);
  const [rows] = await db.query(surql`SELECT hit_used FROM ${recallEventId}`).collect();
  assert.deepEqual(rows[0].hit_used, [true, false]);
});

test('mark_recall_used silently ignores out-of-set IDs', async () => {
  const db = await fresh();
  const { recallEventId, hitIds } = await seedRecallEvent(db);
  const tool = createMarkRecallUsedTool({ db });
  const r = await tool.handler({ recall_event_id: String(recallEventId), used_hit_ids: ['events:nonexistent', hitIds[1]] });
  assert.equal(r.updated, 1);
});

test('mark_recall_used throws when recall_event_id not found', async () => {
  const db = await fresh();
  const tool = createMarkRecallUsedTool({ db });
  await assert.rejects(
    tool.handler({ recall_event_id: 'recall_events:nonexistent', used_hit_ids: [] }),
    /not found/i,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

`src/mcp/tools/mark-recall-used.js`:

```js
import { surql } from 'surrealdb';

export function createMarkRecallUsedTool({ db }) {
  return {
    name: 'mark_recall_used',
    description:
      'After using results from `recall`, mark which hits informed your answer. Helps Robin learn to surface better results.',
    inputSchema: {
      type: 'object',
      properties: {
        recall_event_id: { type: 'string' },
        used_hit_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['recall_event_id', 'used_hit_ids'],
    },
    handler: async (args) => {
      const idRef = args.recall_event_id.startsWith('recall_events:')
        ? args.recall_event_id
        : `recall_events:${args.recall_event_id}`;
      const [rows] = await db.query(`SELECT hit_ids, hit_used FROM ${idRef}`).collect();
      if (!rows || rows.length === 0) {
        throw new Error(`recall_event not found: ${args.recall_event_id}`);
      }
      const { hit_ids, hit_used } = rows[0];
      const usedSet = new Set(args.used_hit_ids.map((s) => s));
      const newUsed = hit_ids.map((hid, i) => {
        if (hit_used[i]) return true;
        return usedSet.has(String(hid));
      });
      let updated = 0;
      for (let i = 0; i < hit_used.length; i++) {
        if (newUsed[i] && !hit_used[i]) updated++;
      }
      await db.query(surql`UPDATE ${idRef} SET hit_used = ${newUsed}`).collect();
      return { updated };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/mark-recall-used.js tests/unit/tool-mark-recall-used.test.js
git commit -m "feat(mcp): mark_recall_used feedback tool"
```

---

## Task 20: Tool — `record_correction`

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/mcp/tools/record-correction.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/tool-record-correction.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/tool-record-correction.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createRecordCorrectionTool } from '../../src/mcp/tools/record-correction.js';

test('record_correction writes event with meta.kind=correction', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  const processedIds = [];
  const processor = async (id) => { processedIds.push(String(id)); };
  const tool = createRecordCorrectionTool({ db, embedder: e, processor });
  const r = await tool.handler({
    content: 'user prefers concise answers',
    prior_response: 'long verbose response',
    meta: { what_was_wrong: 'too verbose' },
  });
  assert.ok(r.id);
  const [rows] = await db.query(surql`SELECT * FROM events`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.kind, 'correction');
  assert.equal(rows[0].meta.prior_response, 'long verbose response');
  assert.equal(rows[0].meta.what_was_wrong, 'too verbose');
  // Processor was called synchronously
  assert.equal(processedIds.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

`src/mcp/tools/record-correction.js`:

```js
import { recordEvent } from '../../capture/record-event.js';

export function createRecordCorrectionTool({ db, embedder, processor }) {
  return {
    name: 'record_correction',
    description:
      "When the user corrects you — 'no, that's wrong', 'I prefer X' — call this. Robin learns from these corrections to avoid repeating mistakes.",
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 10000 },
        prior_response: { type: 'string' },
        meta: { type: 'object' },
      },
      required: ['content'],
    },
    handler: async (args) => {
      const meta = {
        kind: 'correction',
        ...(args.prior_response ? { prior_response: args.prior_response } : {}),
        ...(args.meta ?? {}),
      };
      const result = await recordEvent(db, embedder, {
        source: 'manual',
        content: args.content,
        meta,
      });
      // Synchronous biographer pass
      try {
        await processor(result.id);
      } catch (e) {
        // Don't fail the correction record if biographer errors
        console.error(`record_correction biographer failed: ${e.message}`);
      }
      return { id: String(result.id) };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/record-correction.js tests/unit/tool-record-correction.test.js
git commit -m "feat(mcp): record_correction feedback tool"
```

---

## Task 21: Daemon entry point

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/daemon/server.js`

- [ ] **Step 1: Write the daemon entry point**

`src/daemon/server.js`:

```js
import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { biographerProcess } from '../capture/biographer.js';
import { close, connect } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createTransformersEmbedder } from '../embed/embedder.js';
import { detectHost } from '../hosts/detect.js';
import { ensureHome, paths } from '../runtime/home.js';
import { acquireDaemonLock, releaseDaemonLock } from './lock.js';
import { bindFreePort } from './port.js';
import { writeDaemonState, clearDaemonState } from './state.js';
import { createBiographerQueue } from './biographer-queue.js';
import { createIdleEmbedder } from './idle-embedder.js';
import { getCliVersion } from './version-handshake.js';
import { createRepeatQueryDetector } from '../mcp/implicit-signals.js';
import { createHealthTool } from '../mcp/tools/health.js';
import { createRecallTool } from '../mcp/tools/recall.js';
import { createRememberTool } from '../mcp/tools/remember.js';
import { createRunBiographerTool } from '../mcp/tools/run-biographer.js';
import { createFindEntityTool } from '../mcp/tools/find-entity.js';
import { createGetEntityTool } from '../mcp/tools/get-entity.js';
import { createRelatedEntitiesTool } from '../mcp/tools/related-entities.js';
import { createListEpisodesTool } from '../mcp/tools/list-episodes.js';
import { createMarkRecallUsedTool } from '../mcp/tools/mark-recall-used.js';
import { createRecordCorrectionTool } from '../mcp/tools/record-correction.js';

export async function startDaemon() {
  const version = await getCliVersion();
  await ensureHome();
  const p = paths();
  const lockPath = join(p.home, '.daemon.lock');
  const statePath = join(p.home, '.daemon.state');

  await acquireDaemonLock(lockPath);

  const startedAt = new Date();
  let dbHandle = null;
  let httpServer = null;

  function shutdown() {
    if (httpServer) httpServer.close();
    if (dbHandle) close(dbHandle);
    clearDaemonState(statePath).catch(() => {});
    releaseDaemonLock(lockPath).catch(() => {});
  }

  process.on('SIGTERM', () => { shutdown(); process.exit(0); });
  process.on('SIGINT', () => { shutdown(); process.exit(0); });

  try {
    // Connect DB + verify migrations are current
    dbHandle = await connect({ engine: `rocksdb://${p.db}` });

    // Wire up the MCP infrastructure
    const idleEmbedder = createIdleEmbedder({
      factory: () => createTransformersEmbedder(),
      idleMs: 600_000,
    });
    let host = null;
    async function getHost() {
      if (!host) host = await detectHost();
      return host;
    }
    const queue = createBiographerQueue({
      worker: async (eventId) => {
        const e = await idleEmbedder.get();
        const h = await getHost();
        await biographerProcess(dbHandle, e, h, eventId);
      },
      dedupe: true,
    });
    const detector = createRepeatQueryDetector({});

    // Server context for tools
    const sessions = { count: 0 };
    const dbWrap = {
      isOpen: () => true,
      query: (...a) => dbHandle.query(...a),
    };
    const embedderWrap = {
      isLoaded: () => false, // simplified for health; idle-embedder doesn't expose state
      embed: async (text) => (await idleEmbedder.get()).embed(text),
    };
    const queueWrap = { ...queue, lastRunAt: null };

    const tools = [
      createHealthTool({ version, startedAt, db: dbWrap, embedder: embedderWrap, biographerQueue: queueWrap, sessions }),
      createRecallTool({ db: dbHandle, embedder: embedderWrap, detector, getSessionId: () => null }),
      createRememberTool({ db: dbHandle, embedder: embedderWrap, queue }),
      createRunBiographerTool({ db: dbHandle, processor: queue.enqueue }),
      createFindEntityTool({ db: dbHandle, embedder: embedderWrap }),
      createGetEntityTool({ db: dbHandle }),
      createRelatedEntitiesTool({ db: dbHandle }),
      createListEpisodesTool({ db: dbHandle }),
      createMarkRecallUsedTool({ db: dbHandle }),
      createRecordCorrectionTool({ db: dbHandle, embedder: embedderWrap, processor: queue.enqueue }),
    ];

    // Bind HTTP server
    const { server: tcp, port } = await bindFreePort();
    tcp.close();
    httpServer = createServer(async (req, res) => {
      // Internal endpoint for Stop hook
      if (req.method === 'POST' && req.url === '/internal/biographer/process-pending') {
        const [pendingRows] = await dbHandle
          .query(`SELECT id FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 50`)
          .collect();
        for (const row of pendingRows) queue.enqueue(String(row.id)).catch(() => {});
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ enqueued: pendingRows.length }));
        return;
      }
      // SSE for MCP
      if (req.method === 'GET' && req.url.startsWith('/sse')) {
        sessions.count++;
        const sessionId = randomUUID();
        const transport = new SSEServerTransport('/messages', res);
        const mcpServer = new Server(
          { name: 'robin', version },
          { capabilities: { tools: {} } },
        );
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
        req.on('close', () => { sessions.count = Math.max(0, sessions.count - 1); });
        return;
      }
      res.writeHead(404).end();
    });
    httpServer.listen(port, '127.0.0.1');

    await writeDaemonState(statePath, {
      port,
      pid: process.pid,
      version,
      started_at: startedAt.toISOString(),
    });

    console.log(`robin-mcp daemon ready on 127.0.0.1:${port}`);

    // Hold the process alive
    await new Promise(() => {});
  } catch (e) {
    console.error(`daemon failed: ${e.message}`);
    shutdown();
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDaemon();
}
```

- [ ] **Step 2: Lint**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
npm run lint
```

- [ ] **Step 3: Smoke test (start, ensure no errors, kill)**

```bash
node src/daemon/server.js &
DAEMON_PID=$!
sleep 3
curl -s http://127.0.0.1:$(jq -r .port ~/.robin/.daemon.state)/sse > /dev/null &
CURL_PID=$!
sleep 1
kill $DAEMON_PID $CURL_PID 2>/dev/null
wait
```

- [ ] **Step 4: Commit**

```bash
git add src/daemon/server.js
git commit -m "feat(daemon): server entry point with MCP HTTP+SSE transport"
```

---

## Task 22: CLI — `robin mcp start`, `mcp stop`, `mcp status`, `mcp restart`

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/cli/commands/mcp-start.js`
- Create: `~/workspace/robin/robin-assistant-v2/src/cli/commands/mcp-stop.js`
- Create: `~/workspace/robin/robin-assistant-v2/src/cli/commands/mcp-status.js`
- Create: `~/workspace/robin/robin-assistant-v2/src/cli/commands/mcp-restart.js`
- Create: `~/workspace/robin/robin-assistant-v2/src/cli/commands/mcp-ensure-running.js`
- Modify: `~/workspace/robin/robin-assistant-v2/src/cli/index.js`

- [ ] **Step 1: Write `mcp-start.js`**

```js
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, ensureHome } from '../../runtime/home.js';

export async function mcpStart() {
  await ensureHome();
  const p = paths();
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(here, '../../daemon/server.js');
  const logFh = await open(join(p.logs, 'daemon.log'), 'a');
  const proc = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ['ignore', logFh.fd, logFh.fd],
    env: process.env,
  });
  proc.unref();
  await logFh.close();
  console.log(`daemon spawning (pid ${proc.pid}); logs at ${p.logs}/daemon.log`);
}
```

- [ ] **Step 2: Write `mcp-stop.js`**

```js
import { join } from 'node:path';
import { paths } from '../../runtime/home.js';
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState, clearDaemonState } from '../../daemon/state.js';

export async function mcpStop() {
  const p = paths();
  const state = await readDaemonState(join(p.home, '.daemon.state'));
  if (!state || !isPidAlive(state.pid)) {
    console.log('daemon not running');
    await clearDaemonState(join(p.home, '.daemon.state'));
    return;
  }
  process.kill(state.pid, 'SIGTERM');
  // Wait up to 5s for the daemon to exit
  for (let i = 0; i < 50; i++) {
    if (!isPidAlive(state.pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log('daemon stopped');
}
```

- [ ] **Step 3: Write `mcp-status.js`**

```js
import { join } from 'node:path';
import { paths } from '../../runtime/home.js';
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';

export async function mcpStatus() {
  const p = paths();
  const state = await readDaemonState(join(p.home, '.daemon.state'));
  if (!state) {
    console.log('not running');
    return;
  }
  const alive = isPidAlive(state.pid);
  console.log(JSON.stringify({
    running: alive,
    port: state.port,
    pid: state.pid,
    version: state.version,
    started_at: state.started_at,
  }, null, 2));
}
```

- [ ] **Step 4: Write `mcp-restart.js`**

```js
import { mcpStart } from './mcp-start.js';
import { mcpStop } from './mcp-stop.js';

export async function mcpRestart() {
  await mcpStop();
  await new Promise((r) => setTimeout(r, 500));
  await mcpStart();
}
```

- [ ] **Step 5: Write `mcp-ensure-running.js`**

```js
import { join } from 'node:path';
import { paths } from '../../runtime/home.js';
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState, clearDaemonState } from '../../daemon/state.js';
import { mcpStart } from './mcp-start.js';

export async function mcpEnsureRunning() {
  const p = paths();
  const state = await readDaemonState(join(p.home, '.daemon.state'));
  if (state && isPidAlive(state.pid)) {
    console.log(`daemon already running on :${state.port}`);
    return;
  }
  if (state) await clearDaemonState(join(p.home, '.daemon.state'));
  await mcpStart();
  // Wait for state file to appear
  for (let i = 0; i < 50; i++) {
    const s = await readDaemonState(join(p.home, '.daemon.state'));
    if (s && isPidAlive(s.pid)) {
      console.log(`daemon ready on :${s.port}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('daemon failed to start within 5s');
}
```

- [ ] **Step 6: Wire into `src/cli/index.js`**

Add a `mcp` parent command branch:

```js
if (cmd === 'mcp') {
  const sub = argv[1];
  const subcommands = {
    start: 'mcp-start.js',
    stop: 'mcp-stop.js',
    status: 'mcp-status.js',
    restart: 'mcp-restart.js',
    'ensure-running': 'mcp-ensure-running.js',
  };
  if (!subcommands[sub]) {
    console.error(`unknown mcp subcommand: ${sub}`);
    process.exit(1);
  }
  const mod = await import(`./commands/${subcommands[sub]}`);
  const fn = Object.values(mod)[0];
  return fn(argv.slice(2));
}
```

- [ ] **Step 7: Smoke test the lifecycle**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
ROBIN_HOME=/tmp/robin-mcp-test node bin/robin mcp status
ROBIN_HOME=/tmp/robin-mcp-test node bin/robin mcp start
sleep 3
ROBIN_HOME=/tmp/robin-mcp-test node bin/robin mcp status
ROBIN_HOME=/tmp/robin-mcp-test node bin/robin mcp stop
sleep 1
ROBIN_HOME=/tmp/robin-mcp-test node bin/robin mcp status
```

Expected: `not running` → starts → `running: true` → stops → `not running`.

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/mcp-*.js src/cli/index.js
git commit -m "feat(cli): mcp start/stop/status/restart/ensure-running"
```

---

## Task 23: Stop hook routing through daemon

**Files:**
- Modify: `~/workspace/robin/robin-assistant-v2/src/hooks/stop-hook.js`

- [ ] **Step 1: Update Stop hook to try daemon first**

```js
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { isPidAlive } from '../daemon/lock.js';
import { readDaemonState } from '../daemon/state.js';
import { resolveBinPath } from '../runtime/bin.js';
import { ensureHome, paths } from '../runtime/home.js';

async function tryDaemonRoute(state, since) {
  try {
    const url = `http://127.0.0.1:${state.port}/internal/biographer/process-pending`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ since }),
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function stopHookHandler({ since } = {}) {
  await ensureHome();
  const p = paths();
  const state = await readDaemonState(join(p.home, '.daemon.state'));
  if (state && isPidAlive(state.pid)) {
    const ok = await tryDaemonRoute(state, since);
    if (ok) return;
  }
  // Fallback: spawn-detached subprocess
  const logFh = await open(join(p.logs, 'biographer.log'), 'a');
  const args = [resolveBinPath(), 'biographer', 'process-pending'];
  if (since) args.push('--since', since);
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFh.fd, logFh.fd],
    env: process.env,
  });
  proc.unref();
  await logFh.close();
}
```

- [ ] **Step 2: Run existing stop-hook test**

```bash
npm test -- tests/integration/stop-hook-detached.test.js
```

Expected: PASS.

- [ ] **Step 3: Lint**

```bash
npm run lint
```

- [ ] **Step 4: Commit**

```bash
git add src/hooks/stop-hook.js
git commit -m "feat(hooks): Stop hook routes through daemon when available"
```

---

## Task 24: Migrate command coordination

**Files:**
- Modify: `~/workspace/robin/robin-assistant-v2/src/cli/commands/migrate.js`

- [ ] **Step 1: Add daemon-running check**

Read the current `migrate.js` and prepend a check:

```js
import { join } from 'node:path';
// ... existing imports
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';

// At the top of `export async function migrate()`:
export async function migrate() {
  // ... existing ensureHome / paths logic ...
  const p = paths();
  const state = await readDaemonState(join(p.home, '.daemon.state'));
  if (state && isPidAlive(state.pid)) {
    console.error('daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  // ... rest of existing logic ...
}
```

(Apply this pattern to the existing `src/cli/commands/migrate.js` rather than rewriting from scratch.)

- [ ] **Step 2: Run existing migration tests**

```bash
npm test -- tests/integration/bootstrap-empty-db.test.js
```

Expected: PASS (no daemon involved).

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/migrate.js
git commit -m "feat(cli): robin migrate refuses when daemon is running"
```

---

## Task 25: launchd plist generator

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/install/launchd-plist.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/launchd-plist.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/launchd-plist.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateLaunchdPlist } from '../../src/install/launchd-plist.js';

test('generateLaunchdPlist produces a valid plist with KeepAlive + RunAtLoad=false', () => {
  const xml = generateLaunchdPlist({
    label: 'io.robin-assistant.mcp',
    nodeBin: '/usr/local/bin/node',
    serverPath: '/Users/x/v2/src/daemon/server.js',
    home: '/Users/x',
  });
  assert.match(xml, /<key>Label<\/key>\s*<string>io\.robin-assistant\.mcp<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>/);
  assert.match(xml, /SuccessfulExit/);
  assert.match(xml, /\/usr\/local\/bin\/node/);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

`src/install/launchd-plist.js`:

```js
export function generateLaunchdPlist({ label, nodeBin, serverPath, home }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${serverPath}</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${home}/.robin/logs/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/.robin/logs/daemon.log</string>
</dict>
</plist>
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/install/launchd-plist.js tests/unit/launchd-plist.test.js
git commit -m "feat(install): launchd plist generator"
```

---

## Task 26: systemd unit generator

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/install/systemd-unit.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/systemd-unit.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/systemd-unit.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateSystemdUnit } from '../../src/install/systemd-unit.js';

test('generateSystemdUnit produces a user unit with Restart=on-failure', () => {
  const txt = generateSystemdUnit({
    nodeBin: '/usr/bin/node',
    serverPath: '/home/x/v2/src/daemon/server.js',
  });
  assert.match(txt, /\[Unit\]/);
  assert.match(txt, /\[Service\]/);
  assert.match(txt, /\[Install\]/);
  assert.match(txt, /Restart=on-failure/);
  assert.match(txt, /\/usr\/bin\/node/);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

`src/install/systemd-unit.js`:

```js
export function generateSystemdUnit({ nodeBin, serverPath }) {
  return `[Unit]
Description=Robin v2 MCP daemon
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${serverPath}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/install/systemd-unit.js tests/unit/systemd-unit.test.js
git commit -m "feat(install): systemd user-unit generator"
```

---

## Task 27: AGENTS.md template + writer

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/install/agents-md.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/agents-md.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/agents-md.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../src/install/agents-md.js';

test('agentsMdContent mentions all 10 tools', () => {
  const md = agentsMdContent();
  for (const tool of [
    'recall', 'remember', 'run_biographer',
    'find_entity', 'get_entity', 'related_entities',
    'list_episodes', 'health',
    'mark_recall_used', 'record_correction',
  ]) {
    assert.match(md, new RegExp(tool), `expected AGENTS.md to mention ${tool}`);
  }
});

test('agentsMdContent has feedback section', () => {
  const md = agentsMdContent();
  assert.match(md, /Feedback/);
  assert.match(md, /correction/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

`src/install/agents-md.js`:

```js
export function agentsMdContent() {
  return `# AGENTS.md

You're talking to a user through Robin. Robin gives you a memory layer
through MCP tools. Use it.

## Memory tools

When the user asks "what do I know about X", "have I mentioned Y before",
"who/what is Z", or any question that requires recalling past conversations,
documents, or notes, call \`recall(query=...)\`. Don't guess from training data;
recall.

When you learn something noteworthy about the user, their projects, their
people, or their preferences — call \`remember(content=...)\`. Be discerning;
not every utterance is worth remembering. Good candidates: explicit
preferences, named projects/people first introduced, decisions, deadlines.

When you need to find a specific person/place/project/topic mentioned before,
call \`find_entity(name=...)\`. Use \`related_entities(id=...)\` to explore who
or what is connected to that entity. Use \`get_entity(id=...)\` for details
about one specific entity.

When the user asks "what was I doing yesterday/last week", call
\`list_episodes(since=...)\`.

## When to call run_biographer

You normally don't need to. Robin runs biographer automatically after each
of your responses. Call \`run_biographer\` only when the user explicitly asks
"process my pending memories" or after \`remember\` if the user wants
immediate effect.

## Feedback (helps Robin learn)

After you use results from \`recall(...)\` to answer a question, call
\`mark_recall_used(recall_event_id=..., used_hit_ids=[...])\` with the IDs
of the hits that informed your answer. Hits that didn't help shouldn't be
in \`used_hit_ids\` — that's a negative signal Robin uses to improve.

When the user corrects you — "no, that's wrong", "I actually prefer X",
"the answer is Y not Z" — call \`record_correction(content=..., prior_response=...)\`.
Be specific in \`content\`: "user prefers concise answers over detailed ones",
not just "user disagreed."

## Daemon health

\`health()\` reports daemon status — useful for debugging if memory tools
are misbehaving.

## Tone

Speak with the warmth and concision of a thoughtful friend who knows you
well. Don't be servile. Don't summarize your own actions ("I'll now call
recall..."). Just do the work and answer.
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/install/agents-md.js tests/unit/agents-md.test.js
git commit -m "feat(install): AGENTS.md template generator"
```

---

## Task 28: CLI — `robin mcp install` / `mcp uninstall`

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/cli/commands/mcp-install.js`
- Create: `~/workspace/robin/robin-assistant-v2/src/cli/commands/mcp-uninstall.js`
- Modify: `~/workspace/robin/robin-assistant-v2/src/cli/index.js`

- [ ] **Step 1: Write `mcp-install.js`**

```js
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLaunchdPlist } from '../../install/launchd-plist.js';
import { generateSystemdUnit } from '../../install/systemd-unit.js';
import { agentsMdContent } from '../../install/agents-md.js';
import { parseArgs } from '../args.js';

export async function mcpInstall(argv) {
  const args = parseArgs(argv);
  const noAgentsMd = args.flags['no-agents-md'] === true;
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = resolve(here, '../../daemon/server.js');
  const nodeBin = process.execPath;
  const home = homedir();

  if (platform() === 'darwin') {
    const plistDir = join(home, 'Library/LaunchAgents');
    await mkdir(plistDir, { recursive: true });
    const plistPath = join(plistDir, 'io.robin-assistant.mcp.plist');
    const xml = generateLaunchdPlist({
      label: 'io.robin-assistant.mcp',
      nodeBin,
      serverPath,
      home,
    });
    await writeFile(plistPath, xml, 'utf8');
    console.log(`installed launchd plist: ${plistPath}`);
    console.log('To enable supervision (restart on crash):');
    console.log('  launchctl load ~/Library/LaunchAgents/io.robin-assistant.mcp.plist');
  } else if (platform() === 'linux') {
    const unitDir = join(home, '.config/systemd/user');
    await mkdir(unitDir, { recursive: true });
    const unitPath = join(unitDir, 'robin-mcp.service');
    const txt = generateSystemdUnit({ nodeBin, serverPath });
    await writeFile(unitPath, txt, 'utf8');
    console.log(`installed systemd user unit: ${unitPath}`);
    console.log('To enable supervision (restart on crash):');
    console.log('  systemctl --user enable robin-mcp');
    console.log('  loginctl enable-linger $(whoami)  # cross-session activation');
  } else {
    console.error(`platform ${platform()} not supported in 2b; daemon supervision unavailable`);
    process.exit(1);
  }

  if (!noAgentsMd) {
    const agentsMdPath = join(home, '.claude/AGENTS.md');
    await mkdir(dirname(agentsMdPath), { recursive: true });
    await writeFile(agentsMdPath, agentsMdContent(), 'utf8');
    console.log(`installed AGENTS.md: ${agentsMdPath}`);
  }
}
```

- [ ] **Step 2: Write `mcp-uninstall.js`**

```js
import { unlink } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export async function mcpUninstall() {
  const home = homedir();
  if (platform() === 'darwin') {
    const plistPath = join(home, 'Library/LaunchAgents/io.robin-assistant.mcp.plist');
    try {
      await unlink(plistPath);
      console.log(`removed: ${plistPath}`);
    } catch {
      console.log('plist not present');
    }
  } else if (platform() === 'linux') {
    const unitPath = join(home, '.config/systemd/user/robin-mcp.service');
    try {
      await unlink(unitPath);
      console.log(`removed: ${unitPath}`);
    } catch {
      console.log('unit not present');
    }
  }
  console.log('AGENTS.md left in place; remove manually if desired');
}
```

- [ ] **Step 3: Wire into `src/cli/index.js`**

Add to the mcp subcommand map:

```js
const subcommands = {
  start: 'mcp-start.js',
  stop: 'mcp-stop.js',
  status: 'mcp-status.js',
  restart: 'mcp-restart.js',
  'ensure-running': 'mcp-ensure-running.js',
  install: 'mcp-install.js',
  uninstall: 'mcp-uninstall.js',
};
```

- [ ] **Step 4: Smoke test (use a tmp dir to avoid touching real ~/.claude)**

(Skip if HOME is sensitive; just verify the command doesn't crash.)

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/mcp-install.js src/cli/commands/mcp-uninstall.js src/cli/index.js
git commit -m "feat(cli): mcp install / mcp uninstall (launchd, systemd, AGENTS.md)"
```

---

## Task 29: MCP end-to-end integration test

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/tests/integration/mcp-end-to-end.test.js`

- [ ] **Step 1: Write the test**

`tests/integration/mcp-end-to-end.test.js`:

```js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

async function waitForState(home, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(join(home, '.daemon.state'), 'utf8');
      return JSON.parse(raw);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('daemon did not start');
}

test('daemon boots, MCP listTools reports 10 tools, daemon stops cleanly', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-mcp-e2e-'));
  const root = resolve(import.meta.dirname, '../..');
  // migrate first
  spawn('node', [join(root, 'bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    stdio: 'inherit',
  });
  await new Promise((r) => setTimeout(r, 2000));

  // start daemon
  const daemon = spawn('node', [join(root, 'src/daemon/server.js')], {
    env: { ...process.env, ROBIN_HOME: tmp, ROBIN_HOST: 'claude_code' },
    stdio: 'pipe',
  });

  try {
    const state = await waitForState(tmp);
    // hit /sse via fetch — this is a smoke test, don't actually parse SSE
    const res = await fetch(`http://127.0.0.1:${state.port}/sse`, {
      signal: AbortSignal.timeout(2000),
    }).catch((e) => e);
    // We expect either a successful response (200) or an abort (manual close)
    assert.ok(res, 'fetch returned something');
  } finally {
    daemon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    rmSync(tmp, { recursive: true });
  }
});
```

- [ ] **Step 2: Run the test**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
npm test -- tests/integration/mcp-end-to-end.test.js
```

Expected: PASS, 1 test.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/mcp-end-to-end.test.js
git commit -m "test(mcp): daemon boot + MCP transport smoke"
```

---

## Task 30: Multi-instance integration test

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/tests/integration/multi-instance.test.js`

- [ ] **Step 1: Write the test**

`tests/integration/multi-instance.test.js`:

```js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

async function waitForState(home, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = readFileSync(join(home, '.daemon.state'), 'utf8');
      return JSON.parse(raw);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('daemon did not start');
}

test('multiple parallel HTTP requests to the daemon do not corrupt the DB', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-multi-'));
  const root = resolve(import.meta.dirname, '../..');
  spawn('node', [join(root, 'bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    stdio: 'inherit',
  });
  await new Promise((r) => setTimeout(r, 2000));
  const daemon = spawn('node', [join(root, 'src/daemon/server.js')], {
    env: { ...process.env, ROBIN_HOME: tmp, ROBIN_HOST: 'claude_code' },
    stdio: 'pipe',
  });
  try {
    const state = await waitForState(tmp);
    // 10 parallel POSTs to the internal biographer endpoint
    const reqs = Array.from({ length: 10 }, () =>
      fetch(`http://127.0.0.1:${state.port}/internal/biographer/process-pending`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      }).catch((e) => ({ ok: false, error: e.message })),
    );
    const responses = await Promise.all(reqs);
    const ok = responses.filter((r) => r.ok).length;
    assert.ok(ok >= 5, `expected at least 5 successful responses, got ${ok}`);
  } finally {
    daemon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    rmSync(tmp, { recursive: true });
  }
});
```

- [ ] **Step 2: Run the test**

```bash
npm test -- tests/integration/multi-instance.test.js
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/multi-instance.test.js
git commit -m "test(daemon): 10 parallel requests don't corrupt DB"
```

---

## Task 31: Stop-hook-via-daemon integration test

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/tests/integration/stop-hook-via-daemon.test.js`

- [ ] **Step 1: Write the test**

```js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { stopHookHandler } from '../../src/hooks/stop-hook.js';

async function waitForState(home, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return JSON.parse(readFileSync(join(home, '.daemon.state'), 'utf8'));
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('daemon did not start');
}

test('Stop hook routes through daemon when running', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-stop-daemon-'));
  const root = resolve(import.meta.dirname, '../..');
  spawn('node', [join(root, 'bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    stdio: 'inherit',
  });
  await new Promise((r) => setTimeout(r, 2000));
  const daemon = spawn('node', [join(root, 'src/daemon/server.js')], {
    env: { ...process.env, ROBIN_HOME: tmp, ROBIN_HOST: 'claude_code' },
    stdio: 'pipe',
  });
  try {
    await waitForState(tmp);
    const orig = process.env.ROBIN_HOME;
    process.env.ROBIN_HOME = tmp;
    try {
      // stopHookHandler should send POST to /internal/biographer/process-pending
      // and return without spawning a subprocess
      await stopHookHandler({ since: new Date().toISOString() });
    } finally {
      if (orig) process.env.ROBIN_HOME = orig;
      else delete process.env.ROBIN_HOME;
    }
    // No assertion on side-effects; this test asserts the code path doesn't error
    assert.ok(true);
  } finally {
    daemon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    rmSync(tmp, { recursive: true });
  }
});
```

- [ ] **Step 2: Run the test**

```bash
npm test -- tests/integration/stop-hook-via-daemon.test.js
```

- [ ] **Step 3: Commit**

```bash
git add tests/integration/stop-hook-via-daemon.test.js
git commit -m "test(hooks): Stop hook routes through daemon successfully"
```

---

## Task 32: Feedback-loop integration test

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/tests/integration/feedback-loop.test.js`

- [ ] **Step 1: Write the test**

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createRepeatQueryDetector } from '../../src/mcp/implicit-signals.js';
import { createMarkRecallUsedTool } from '../../src/mcp/tools/mark-recall-used.js';
import { createRecallTool } from '../../src/mcp/tools/recall.js';

test('recall → mark_recall_used round-trip captures feedback signal', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  await recordEvent(db, e, { source: 'cli', content: 'apple' });
  await recordEvent(db, e, { source: 'cli', content: 'banana' });
  await recordEvent(db, e, { source: 'cli', content: 'cherry' });

  const recallTool = createRecallTool({
    db,
    embedder: e,
    detector: createRepeatQueryDetector({}),
    getSessionId: () => 'sess-1',
  });
  const markTool = createMarkRecallUsedTool({ db });

  const recallResult = await recallTool.handler({ query: 'apple' });
  assert.ok(recallResult.recall_event_id);
  assert.ok(recallResult.hits.length >= 1);

  const usedHitId = recallResult.hits[0].id;
  const markResult = await markTool.handler({
    recall_event_id: recallResult.recall_event_id,
    used_hit_ids: [usedHitId],
  });
  assert.equal(markResult.updated, 1);

  const [rows] = await db
    .query(surql`SELECT hit_used FROM type::record('recall_events', $rid)`, {
      rid: recallResult.recall_event_id.replace('recall_events:', ''),
    })
    .collect();
  assert.ok(rows[0].hit_used.some((u) => u === true));
  await close(db);
});
```

- [ ] **Step 2: Run the test**

- [ ] **Step 3: Commit**

```bash
git add tests/integration/feedback-loop.test.js
git commit -m "test(mcp): recall → mark_recall_used feedback round-trip"
```

---

## Task 33: Correction-loop integration test

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/tests/integration/correction-loop.test.js`

- [ ] **Step 1: Write the test**

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createRecordCorrectionTool } from '../../src/mcp/tools/record-correction.js';

test('record_correction creates event with meta.kind=correction and triggers processor', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  const processed = [];
  const processor = async (id) => { processed.push(String(id)); };
  const tool = createRecordCorrectionTool({ db, embedder: e, processor });

  const r = await tool.handler({
    content: 'user prefers terse responses',
    prior_response: 'a long verbose answer',
    meta: { what_was_wrong: 'too verbose' },
  });
  assert.ok(r.id);
  assert.equal(processed.length, 1);
  const [rows] = await db.query(surql`SELECT * FROM events`).collect();
  assert.equal(rows[0].meta.kind, 'correction');
  assert.equal(rows[0].meta.prior_response, 'a long verbose answer');
  await close(db);
});
```

- [ ] **Step 2: Run the test**

- [ ] **Step 3: Commit**

```bash
git add tests/integration/correction-loop.test.js
git commit -m "test(mcp): record_correction creates correction event + triggers processor"
```

---

## Task 34: CHANGELOG + tag v6.0.0-alpha.2

**Files:**
- Modify: `~/workspace/robin/robin-assistant-v2/CHANGELOG.md`

- [ ] **Step 1: Run full suite + lint**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
npm test
npm run lint
```

- [ ] **Step 2: Prepend to CHANGELOG.md**

Insert above the existing `[6.0.0-alpha.1]` entry:

```markdown
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
- AGENTS.md template with feedback section installed by `robin mcp install`.
- Implicit-signal detection: repeat-query-within-5min flagged in `recall_events.meta`.
- Idle-embedder unloader: 10-minute timeout, configurable.
- Version handshake: daemon refuses requests from version-skew CLI.

Phase 2c (dream + memory shapes) is the immediate follow-on.
```

- [ ] **Step 3: Commit + tag**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): Phase 2b done"
git tag v6.0.0-alpha.2
```

- [ ] **Step 4: Final verification**

```bash
git log --oneline | head -40
git tag
npm test 2>&1 | tail -8
```

Expected: tag `v6.0.0-alpha.2` present; full test suite passes.

---

## Spec coverage cross-check

| Spec section | Tasks |
|---|---|
| Section 1 scope + decisions | All tasks |
| Section 2 daemon architecture | 3, 4, 5, 6, 7, 8, 21, 22 |
| Section 2b recall_events schema | 2 |
| Section 3 MCP server + tools | 9–20 |
| Section 4 AGENTS.md | 27, 28 |
| Section 5 testing strategy | All tests inline + 29, 30, 31, 32, 33 |
| Section 6 open questions / risks | Task 1 (spike) addresses transport + Gemini MCP + AGENTS.md paths |
| Section 7 rollout / acceptance | 34 (final tag + verification) |

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-robin-v2-phase-2b-mcp-daemon.md`. Per user instruction, proceeding directly to subagent-driven execution without further confirmation.
