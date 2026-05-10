# Phase 4d — Daemon-Internal Job Runner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a markdown-defined job runner that lives inside the daemon's heartbeat scheduler, plus the daily-briefing port as proof.

**Architecture:** Jobs are markdown files (YAML frontmatter + body) globbed from `src/jobs/builtin/` and `<robinHome>/jobs/`, with user-wins-by-name merge. The existing heartbeat scheduler (`src/daemon/scheduler.js`) gets a third surface alongside integrations and dream. Per-job state in a new `runtime_jobs` table. Two runtimes: `agent` (LLM-driven via `host.invokeLLM`) and `internal` (registered functions). Notifications dispatch to discord_send (via tool-array lookup), recordEvent capture, both, or nothing.

**Tech Stack:** Node.js 22+, SurrealDB v3 (rocksdb in prod, mem in tests), discord.js v14 (for notify), node:test, biome.

**Spec:** `docs/superpowers/specs/2026-05-10-robin-v2-phase-4d-jobs-design.md` (commit `4158529`).

**Coordination note:** Avoid the other agent's Phase 4f territory: `src/capture/`, `src/hooks/handlers/`, `src/daemon/sessions.js`, `runtime_sessions`, `runtime_auto_recall_telemetry`, `src/cli/commands/biographer-*`. This plan stays clear.

---

## File map (locked before tasks)

**New:**
```
src/schema/migrations/0011-jobs.surql
src/jobs/cron.js
src/jobs/loader.js
src/jobs/db.js
src/jobs/notify.js
src/jobs/runner.js
src/jobs/scheduler-ext.js
src/jobs/builtin/daily-briefing.md
src/jobs/internal/.gitkeep
src/cli/commands/jobs-list.js
src/cli/commands/jobs-status.js
src/cli/commands/jobs-run.js
src/cli/commands/jobs-enable.js
src/cli/commands/jobs-disable.js
src/cli/commands/jobs-reload.js
src/mcp/tools/list-jobs.js
src/mcp/tools/run-job.js
tests/unit/cron-parser.test.js
tests/unit/jobs-loader.test.js
tests/unit/jobs-db.test.js
tests/unit/jobs-notify.test.js
tests/unit/jobs-runner.test.js
tests/unit/jobs-scheduler-ext.test.js
tests/unit/jobs-cli.test.js
tests/unit/jobs-mcp.test.js
tests/unit/agents-md-jobs.test.js
tests/integration/jobs-roundtrip.test.js
```

**Modified (additive only — don't refactor):**
```
src/cli/index.js                       # dispatch 'jobs' subcommand
src/daemon/server.js                   # wire jobs into scheduler + MCP + /internal endpoint
src/install/agents-md.js               # render jobs section
src/cli/commands/mcp-install.js        # pass jobs array to agentsMdContent
```

---

## Task 1: Schema migration `0011-jobs.surql`

**Files:**
- Create: `src/schema/migrations/0011-jobs.surql`
- Test: `tests/integration/jobs-roundtrip.test.js` (deferred to Task 14 — for now, the unit tests in Task 4 exercise the table)

- [ ] **Step 1: Write the migration**

```sql
-- 0011-jobs.surql — runtime_jobs table for the daemon-internal job runner.
DEFINE TABLE runtime_jobs SCHEMAFULL;
DEFINE FIELD name              ON runtime_jobs TYPE string;
DEFINE FIELD enabled           ON runtime_jobs TYPE bool;
DEFINE FIELD schedule          ON runtime_jobs TYPE string;
DEFINE FIELD runtime           ON runtime_jobs TYPE string ASSERT $value IN ['agent', 'internal'];
DEFINE FIELD catch_up          ON runtime_jobs TYPE bool;
DEFINE FIELD notify            ON runtime_jobs TYPE string;
DEFINE FIELD notify_on_failure ON runtime_jobs TYPE bool;
DEFINE FIELD timeout_minutes   ON runtime_jobs TYPE int;
DEFINE FIELD manually_runnable ON runtime_jobs TYPE bool DEFAULT true;
DEFINE FIELD last_run_at       ON runtime_jobs TYPE option<datetime>;
DEFINE FIELD last_run_ok       ON runtime_jobs TYPE option<bool>;
DEFINE FIELD last_error        ON runtime_jobs TYPE option<string>;
DEFINE FIELD last_duration_ms  ON runtime_jobs TYPE option<int>;
DEFINE FIELD next_run_at       ON runtime_jobs TYPE option<datetime>;
DEFINE FIELD consecutive_failures ON runtime_jobs TYPE int DEFAULT 0;
DEFINE FIELD in_flight         ON runtime_jobs TYPE bool DEFAULT false;
DEFINE FIELD updated_at        ON runtime_jobs TYPE datetime DEFAULT time::now();
DEFINE INDEX runtime_jobs_name ON runtime_jobs FIELDS name UNIQUE;
```

- [ ] **Step 2: Run existing migration test to make sure nothing else broke**

```
node --test --test-force-exit tests/integration/migration-0009.test.js tests/integration/0008-migrations.test.js
```

Expected: still passing.

- [ ] **Step 3: Run lint**

```
npm run lint
```

Expected: 0 errors (biome doesn't lint `.surql` files; this confirms the file didn't trip anything else).

- [ ] **Step 4: Commit**

```
git add src/schema/migrations/0011-jobs.surql
git commit -m "feat(4d): runtime_jobs migration 0011"
```

---

## Task 2: Cron parser

**Files:**
- Create: `src/jobs/cron.js`
- Test: `tests/unit/cron-parser.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/cron-parser.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCron, nextFire, prevFire, expectedIntervalMs } from '../../src/jobs/cron.js';

test('parseCron — 5-field hourly', () => {
  const p = parseCron('0 * * * *');
  assert.deepEqual(p.minute, [0]);
  assert.equal(p.hour, '*');
});

test('parseCron — @-aliases', () => {
  assert.equal(parseCron('@daily').encoded, '0 0 * * *');
  assert.equal(parseCron('@hourly').encoded, '0 * * * *');
  assert.equal(parseCron('@weekly').encoded, '0 0 * * 0');
  assert.equal(parseCron('@monthly').encoded, '0 0 1 * *');
  assert.equal(parseCron('@yearly').encoded, '0 0 1 1 *');
});

test('parseCron — list, range, step operators', () => {
  parseCron('0 9,17 * * 1-5');     // 9am + 5pm Mon-Fri — must not throw
  parseCron('*/15 * * * *');        // every 15 min — must not throw
  assert.throws(() => parseCron('99 * * * *'), /minute out of range/);
  assert.throws(() => parseCron('bad cron'), /invalid/);
});

test('nextFire — daily 7am from 6:59am same day fires at 7:00 today', () => {
  process.env.TZ = 'America/Los_Angeles';
  const p = parseCron('0 7 * * *');
  const after = new Date('2026-05-10T13:59:00.000Z'); // 06:59 PT
  const n = nextFire(p, after);
  assert.equal(n.toISOString(), '2026-05-10T14:00:00.000Z'); // 07:00 PT
});

test('nextFire — daily 7am from 8am same day fires tomorrow', () => {
  process.env.TZ = 'America/Los_Angeles';
  const p = parseCron('0 7 * * *');
  const after = new Date('2026-05-10T15:00:00.000Z'); // 08:00 PT
  const n = nextFire(p, after);
  assert.equal(n.toISOString(), '2026-05-11T14:00:00.000Z');
});

test('prevFire — daily 7am from 8am same day → 7am same day', () => {
  process.env.TZ = 'America/Los_Angeles';
  const p = parseCron('0 7 * * *');
  const before = new Date('2026-05-10T15:00:00.000Z');
  const prev = prevFire(p, before);
  assert.equal(prev.toISOString(), '2026-05-10T14:00:00.000Z');
});

test('expectedIntervalMs — daily ≈ 86_400_000', () => {
  const p = parseCron('@daily');
  const around = new Date('2026-05-10T00:00:00.000Z');
  const ms = expectedIntervalMs(p, around);
  assert.ok(Math.abs(ms - 86_400_000) < 60_000, `got ${ms}`);
});

test('expectedIntervalMs — hourly ≈ 3_600_000', () => {
  const p = parseCron('@hourly');
  const around = new Date('2026-05-10T00:00:00.000Z');
  const ms = expectedIntervalMs(p, around);
  assert.ok(Math.abs(ms - 3_600_000) < 60_000, `got ${ms}`);
});

test('nextFire — @yearly does not blow the iteration cap', () => {
  const p = parseCron('@yearly');
  const after = new Date('2026-01-02T00:00:00.000Z');
  const n = nextFire(p, after);
  assert.equal(n.toISOString(), '2027-01-01T00:00:00.000Z');
});
```

- [ ] **Step 2: Run tests — they fail**

```
node --test --test-force-exit tests/unit/cron-parser.test.js
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the parser**

```js
// src/jobs/cron.js — minimal 5-field cron + @-aliases.
const ALIASES = {
  '@yearly':  '0 0 1 1 *',
  '@annually':'0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly':  '0 0 * * 0',
  '@daily':   '0 0 * * *',
  '@hourly':  '0 * * * *',
};

const RANGES = {
  minute: [0, 59],
  hour:   [0, 23],
  dom:    [1, 31],
  month:  [1, 12],
  dow:    [0, 6],   // 0 = Sunday
};

const ITER_CAP = 5_000_000; // ~10 years of minutes

function parseField(name, raw) {
  const [lo, hi] = RANGES[name];
  if (raw === '*') return '*';
  const out = new Set();
  for (const part of raw.split(',')) {
    let step = 1;
    let body = part;
    if (body.includes('/')) {
      const [b, s] = body.split('/');
      body = b;
      step = Number.parseInt(s, 10);
      if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in ${name}: ${raw}`);
    }
    let a;
    let b;
    if (body === '*') { a = lo; b = hi; }
    else if (body.includes('-')) {
      const [s, e] = body.split('-').map((x) => Number.parseInt(x, 10));
      a = s; b = e;
    } else {
      a = Number.parseInt(body, 10);
      b = a;
    }
    if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`invalid ${name}: ${raw}`);
    if (a < lo || b > hi) throw new Error(`${name} out of range [${lo},${hi}]: ${raw}`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

export function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error('invalid cron: not a string');
  const trimmed = expr.trim();
  const encoded = ALIASES[trimmed] ?? trimmed;
  const fields = encoded.split(/\s+/);
  if (fields.length !== 5) throw new Error(`invalid cron (need 5 fields): ${expr}`);
  const [m, h, d, mo, dw] = fields;
  return {
    encoded,
    minute: parseField('minute', m),
    hour:   parseField('hour', h),
    dom:    parseField('dom', d),
    month:  parseField('month', mo),
    dow:    parseField('dow', dw),
  };
}

function matchField(parsed, value) {
  return parsed === '*' || parsed.includes(value);
}

function matches(parts, date) {
  return (
    matchField(parts.minute, date.getMinutes()) &&
    matchField(parts.hour,   date.getHours()) &&
    matchField(parts.month,  date.getMonth() + 1) &&
    // DOM/DOW union: if both fields are *, match. If either is restricted, OR them.
    (
      (parts.dom === '*' && parts.dow === '*') ||
      (parts.dom !== '*' && matchField(parts.dom, date.getDate())) ||
      (parts.dow !== '*' && matchField(parts.dow, date.getDay()))
    )
  );
}

export function nextFire(parts, after) {
  const t = new Date(after);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < ITER_CAP; i += 1) {
    if (matches(parts, t)) return new Date(t);
    t.setMinutes(t.getMinutes() + 1);
  }
  throw new Error(`nextFire exceeded ${ITER_CAP} iterations for ${parts.encoded}`);
}

export function prevFire(parts, before) {
  const t = new Date(before);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() - 1);
  for (let i = 0; i < ITER_CAP; i += 1) {
    if (matches(parts, t)) return new Date(t);
    t.setMinutes(t.getMinutes() - 1);
  }
  throw new Error(`prevFire exceeded ${ITER_CAP} iterations for ${parts.encoded}`);
}

export function expectedIntervalMs(parts, around) {
  const next = nextFire(parts, around);
  const after = nextFire(parts, next);
  return after.getTime() - next.getTime();
}
```

- [ ] **Step 4: Run tests — they pass**

```
node --test --test-force-exit tests/unit/cron-parser.test.js
```

Expected: all 9 pass.

- [ ] **Step 5: Lint + commit**

```
npm run lint
git add src/jobs/cron.js tests/unit/cron-parser.test.js
git commit -m "feat(4d): minimal 5-field cron parser + @-aliases"
```

---

## Task 3: Job markdown loader

Discovers + parses + merges built-in and user jobs.

**Files:**
- Create: `src/jobs/loader.js`
- Test: `tests/unit/jobs-loader.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/jobs-loader.test.js
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverJobs, parseJobFile, validateJob } from '../../src/jobs/loader.js';

let tmp;
test.beforeEach(() => {
  tmp = join(tmpdir(), `robin-jobs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmp, 'builtin'), { recursive: true });
  mkdirSync(join(tmp, 'user'), { recursive: true });
});
test.afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeJob(dir, name, frontmatter, body = 'job body') {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`)
    .join('\n');
  writeFileSync(join(dir, `${name}.md`), `---\n${fm}\n---\n${body}\n`);
}

test('parseJobFile — extracts frontmatter + body', () => {
  writeJob(join(tmp, 'builtin'), 'foo', {
    name: 'foo', schedule: '@daily', runtime: 'agent', enabled: true,
  }, 'hello world');
  const job = parseJobFile(join(tmp, 'builtin', 'foo.md'));
  assert.equal(job.name, 'foo');
  assert.equal(job.schedule, '@daily');
  assert.equal(job.runtime, 'agent');
  assert.equal(job.enabled, true);
  assert.match(job.body, /hello world/);
  assert.equal(job.source, 'builtin');
});

test('validateJob — rejects missing name/schedule/runtime', () => {
  assert.throws(() => validateJob({ schedule: '@daily', runtime: 'agent' }), /name/);
  assert.throws(() => validateJob({ name: 'x', runtime: 'agent' }), /schedule/);
  assert.throws(() => validateJob({ name: 'x', schedule: '@daily' }), /runtime/);
});

test('validateJob — rejects invalid runtime + notify values', () => {
  assert.throws(
    () => validateJob({ name: 'x', schedule: '@daily', runtime: 'bogus' }),
    /runtime/,
  );
  assert.throws(
    () => validateJob({ name: 'x', schedule: '@daily', runtime: 'agent', notify: 'sms' }),
    /notify/,
  );
});

test('validateJob — name/filename mismatch rejected', () => {
  writeJob(join(tmp, 'builtin'), 'foo', { name: 'bar', schedule: '@daily', runtime: 'agent' });
  assert.throws(() => parseJobFile(join(tmp, 'builtin', 'foo.md')), /filename/);
});

test('discoverJobs — merges builtin + user; user wins by name', () => {
  writeJob(join(tmp, 'builtin'), 'foo', {
    name: 'foo', schedule: '@daily', runtime: 'agent', enabled: false,
  }, 'builtin body');
  writeJob(join(tmp, 'user'), 'foo', {
    name: 'foo', schedule: '@hourly', runtime: 'agent', enabled: true,
  }, 'user body');
  writeJob(join(tmp, 'builtin'), 'other', {
    name: 'other', schedule: '@hourly', runtime: 'internal', enabled: false,
  });
  const jobs = discoverJobs({ builtinDir: join(tmp, 'builtin'), userDir: join(tmp, 'user') });
  const byName = Object.fromEntries(jobs.map((j) => [j.name, j]));
  assert.equal(byName.foo.schedule, '@hourly', 'user copy wins');
  assert.equal(byName.foo.source, 'user');
  assert.match(byName.foo.body, /user body/);
  assert.equal(byName.other.source, 'builtin');
});

test('discoverJobs — missing user dir is fine', () => {
  writeJob(join(tmp, 'builtin'), 'foo', {
    name: 'foo', schedule: '@daily', runtime: 'agent', enabled: false,
  });
  const jobs = discoverJobs({
    builtinDir: join(tmp, 'builtin'),
    userDir: join(tmp, 'nonexistent'),
  });
  assert.equal(jobs.length, 1);
});

test('discoverJobs — defaults filled in', () => {
  writeJob(join(tmp, 'builtin'), 'foo', {
    name: 'foo', schedule: '@daily', runtime: 'agent',
  });
  const [job] = discoverJobs({ builtinDir: join(tmp, 'builtin'), userDir: join(tmp, 'user') });
  assert.equal(job.enabled, false);
  assert.equal(job.catch_up, false);
  assert.equal(job.timeout_minutes, 10);
  assert.equal(job.notify, 'none');
  assert.equal(job.notify_on_failure, true);
  assert.equal(job.manually_runnable, true);
});
```

- [ ] **Step 2: Run tests — they fail**

```
node --test --test-force-exit tests/unit/jobs-loader.test.js
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the loader**

```js
// src/jobs/loader.js
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const NOTIFY_VALUES = new Set(['discord_dm', 'capture', 'both', 'none']);
const RUNTIME_VALUES = new Set(['agent', 'internal']);

const DEFAULTS = {
  enabled: false,
  catch_up: false,
  timeout_minutes: 10,
  notify: 'none',
  notify_on_failure: true,
  manually_runnable: true,
  description: '',
};

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error('no YAML frontmatter');
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const eq = line.indexOf(':');
    if (eq < 0) throw new Error(`bad frontmatter line: ${line}`);
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (/^-?\d+$/.test(v)) v = Number.parseInt(v, 10);
    else if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v);
    else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    fm[k] = v;
  }
  return { frontmatter: fm, body: m[2] };
}

export function validateJob(fm) {
  if (typeof fm.name !== 'string' || !fm.name) throw new Error('job: name required');
  if (typeof fm.schedule !== 'string' || !fm.schedule) throw new Error('job: schedule required');
  if (typeof fm.runtime !== 'string') throw new Error('job: runtime required');
  if (!RUNTIME_VALUES.has(fm.runtime)) {
    throw new Error(`job: runtime must be one of ${[...RUNTIME_VALUES].join('|')}`);
  }
  if (fm.notify !== undefined && !NOTIFY_VALUES.has(fm.notify)) {
    throw new Error(`job: notify must be one of ${[...NOTIFY_VALUES].join('|')}`);
  }
}

export function parseJobFile(path, source = 'builtin') {
  const raw = readFileSync(path, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  validateJob(frontmatter);
  const expectedName = basename(path).replace(/\.md$/, '');
  if (frontmatter.name !== expectedName) {
    throw new Error(`job: filename '${expectedName}' must match frontmatter name '${frontmatter.name}'`);
  }
  return { ...DEFAULTS, ...frontmatter, body, source, path };
}

function listMd(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));
}

export function discoverJobs({ builtinDir, userDir }) {
  const byName = new Map();
  for (const p of listMd(builtinDir)) {
    try {
      const job = parseJobFile(p, 'builtin');
      byName.set(job.name, job);
    } catch (e) {
      console.warn(`[jobs] skip builtin ${p}: ${e.message}`);
    }
  }
  for (const p of listMd(userDir)) {
    try {
      const job = parseJobFile(p, 'user');
      byName.set(job.name, job); // user wins
    } catch (e) {
      console.warn(`[jobs] skip user ${p}: ${e.message}`);
    }
  }
  return [...byName.values()];
}
```

- [ ] **Step 4: Run tests — they pass**

```
node --test --test-force-exit tests/unit/jobs-loader.test.js
```

Expected: all 7 pass.

- [ ] **Step 5: Lint + commit**

```
npm run lint
git add src/jobs/loader.js tests/unit/jobs-loader.test.js
git commit -m "feat(4d): job markdown loader with builtin+user merge"
```

---

## Task 4: Runtime jobs DB helpers

UPSERT row on discover, mark in_flight, record success/failure, garbage-collect rows whose file disappeared.

**Files:**
- Create: `src/jobs/db.js`
- Test: `tests/unit/jobs-db.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/jobs-db.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  garbageCollect,
  listAllJobs,
  recordFailure,
  recordSuccess,
  setEnabled,
  setInFlight,
  upsertFromDiscovered,
} from '../../src/jobs/db.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

const SAMPLE = {
  name: 'foo',
  schedule: '@daily',
  runtime: 'agent',
  enabled: true,
  catch_up: true,
  notify: 'capture',
  notify_on_failure: true,
  timeout_minutes: 10,
  manually_runnable: true,
};

test('upsertFromDiscovered — first call creates row with defaults', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE]);
  const rows = await listAllJobs(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'foo');
  assert.equal(rows[0].in_flight, false);
  assert.equal(rows[0].consecutive_failures, 0);
  await close(db);
});

test('upsertFromDiscovered — markdown-authoritative fields update; enabled does NOT', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE]);
  await setEnabled(db, 'foo', false);                       // DB flip
  await upsertFromDiscovered(db, [{ ...SAMPLE, schedule: '@hourly', enabled: true }]);
  const [row] = await listAllJobs(db);
  assert.equal(row.schedule, '@hourly', 'schedule updated from markdown');
  assert.equal(row.enabled, false, 'enabled preserved from DB');
  await close(db);
});

test('garbageCollect — disables rows whose file is gone', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE, { ...SAMPLE, name: 'bar' }]);
  await garbageCollect(db, new Set(['foo']));
  const rows = await listAllJobs(db);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName.foo.enabled, true);
  assert.equal(byName.bar.enabled, false);
  await close(db);
});

test('setInFlight + recordSuccess', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE]);
  await setInFlight(db, 'foo', true);
  let [row] = await listAllJobs(db);
  assert.equal(row.in_flight, true);
  await recordSuccess(db, 'foo', { duration_ms: 250, next_run_at: new Date(Date.now() + 86_400_000) });
  [row] = await listAllJobs(db);
  assert.equal(row.in_flight, false);
  assert.equal(row.last_run_ok, true);
  assert.equal(row.last_duration_ms, 250);
  assert.equal(row.consecutive_failures, 0);
  await close(db);
});

test('recordFailure — bumps consecutive_failures, sets last_error', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE]);
  await setInFlight(db, 'foo', true);
  await recordFailure(db, 'foo', {
    error: 'boom',
    duration_ms: 100,
    next_run_at: new Date(Date.now() + 3_600_000),
  });
  const [row] = await listAllJobs(db);
  assert.equal(row.last_run_ok, false);
  assert.equal(row.last_error, 'boom');
  assert.equal(row.consecutive_failures, 1);
  assert.equal(row.in_flight, false);
  await close(db);
});
```

- [ ] **Step 2: Run tests — they fail**

```
node --test --test-force-exit tests/unit/jobs-db.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement the helpers**

```js
// src/jobs/db.js
import { surql } from 'surrealdb';

// Fields the markdown frontmatter is authoritative for at UPSERT.
// `enabled` is NOT in this list — it's DB-authoritative after row creation.
const MD_AUTHORITATIVE = [
  'schedule', 'runtime', 'catch_up', 'notify', 'notify_on_failure',
  'timeout_minutes', 'manually_runnable',
];

export async function listAllJobs(db) {
  const [rows] = await db.query(surql`SELECT * FROM runtime_jobs`).collect();
  return rows ?? [];
}

export async function getJob(db, name) {
  const [rows] = await db.query(surql`SELECT * FROM runtime_jobs WHERE name = ${name}`).collect();
  return rows?.[0] ?? null;
}

export async function upsertFromDiscovered(db, discovered) {
  for (const job of discovered) {
    const existing = await getJob(db, job.name);
    if (!existing) {
      const row = {
        name: job.name,
        enabled: job.enabled,
        schedule: job.schedule,
        runtime: job.runtime,
        catch_up: job.catch_up,
        notify: job.notify,
        notify_on_failure: job.notify_on_failure,
        timeout_minutes: job.timeout_minutes,
        manually_runnable: job.manually_runnable,
        consecutive_failures: 0,
        in_flight: false,
        updated_at: new Date(),
      };
      await db.query(surql`CREATE runtime_jobs CONTENT ${row}`).collect();
      continue;
    }
    const patch = { updated_at: new Date() };
    for (const k of MD_AUTHORITATIVE) patch[k] = job[k];
    await db
      .query(surql`UPDATE runtime_jobs MERGE ${patch} WHERE name = ${job.name}`)
      .collect();
  }
}

export async function garbageCollect(db, presentNames) {
  const rows = await listAllJobs(db);
  for (const r of rows) {
    if (!presentNames.has(r.name) && r.enabled !== false) {
      await db
        .query(surql`UPDATE runtime_jobs MERGE ${{ enabled: false, updated_at: new Date() }} WHERE name = ${r.name}`)
        .collect();
    }
  }
}

export async function setEnabled(db, name, enabled) {
  await db
    .query(surql`UPDATE runtime_jobs MERGE ${{ enabled, updated_at: new Date() }} WHERE name = ${name}`)
    .collect();
}

export async function setInFlight(db, name, in_flight) {
  await db
    .query(surql`UPDATE runtime_jobs MERGE ${{ in_flight, updated_at: new Date() }} WHERE name = ${name}`)
    .collect();
}

export async function setNextRunAt(db, name, next_run_at) {
  await db
    .query(surql`UPDATE runtime_jobs MERGE ${{ next_run_at, updated_at: new Date() }} WHERE name = ${name}`)
    .collect();
}

export async function recordSuccess(db, name, { duration_ms, next_run_at }) {
  const patch = {
    last_run_at: new Date(),
    last_run_ok: true,
    last_error: null,
    last_duration_ms: duration_ms,
    consecutive_failures: 0,
    in_flight: false,
    next_run_at,
    updated_at: new Date(),
  };
  await db
    .query(surql`UPDATE runtime_jobs MERGE ${patch} WHERE name = ${name}`)
    .collect();
}

export async function recordFailure(db, name, { error, duration_ms, next_run_at }) {
  const existing = await getJob(db, name);
  const patch = {
    last_run_at: new Date(),
    last_run_ok: false,
    last_error: String(error).slice(0, 2000),
    last_duration_ms: duration_ms,
    consecutive_failures: (existing?.consecutive_failures ?? 0) + 1,
    in_flight: false,
    next_run_at,
    updated_at: new Date(),
  };
  await db
    .query(surql`UPDATE runtime_jobs MERGE ${patch} WHERE name = ${name}`)
    .collect();
}
```

- [ ] **Step 4: Run tests — they pass**

```
node --test --test-force-exit tests/unit/jobs-db.test.js
```

Expected: all 5 pass.

- [ ] **Step 5: Lint + commit**

```
npm run lint
git add src/jobs/db.js tests/unit/jobs-db.test.js
git commit -m "feat(4d): runtime_jobs DB helpers (upsert, garbage-collect, run-state)"
```

---

## Task 5: Notify dispatch

**Files:**
- Create: `src/jobs/notify.js`
- Test: `tests/unit/jobs-notify.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/jobs-notify.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import { dispatchNotify } from '../../src/jobs/notify.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const capture = createCapture({
    db,
    embedder: createStubEmbedder({ dimension: 1024 }),
    source: 'job_output',
    embed: false,
    mode: 'insert-or-skip',
  });
  return { db, capture };
}

const fakeDiscordTool = () => {
  const calls = [];
  return {
    tool: {
      name: 'discord_send',
      handler: async (input) => {
        calls.push(input);
        return { ok: true, message_id: 'm1' };
      },
    },
    calls,
  };
};

test('notify: capture — writes job_output event', async () => {
  const { db, capture } = await fresh();
  await dispatchNotify({
    db,
    capture,
    name: 'foo',
    notify: 'capture',
    output: 'morning summary',
    tools: [],
    kind: 'success',
  });
  const [rows] = await db.query("SELECT * FROM events WHERE source = 'job_output'").collect();
  assert.equal(rows.length, 1);
  assert.match(rows[0].external_id, /^foo:/);
  await close(db);
});

test('notify: discord_dm — calls discord_send with first allowlisted user', async () => {
  process.env.DISCORD_ALLOWED_USER_IDS = 'u1,u2';
  const { db, capture } = await fresh();
  const { tool, calls } = fakeDiscordTool();
  await dispatchNotify({
    db,
    capture,
    name: 'foo',
    notify: 'discord_dm',
    output: 'hi',
    tools: [tool],
    kind: 'success',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'send_dm');
  assert.equal(calls[0].args.user_id, 'u1');
  assert.equal(calls[0].args.content, 'hi');
  Reflect.deleteProperty(process.env, 'DISCORD_ALLOWED_USER_IDS');
  await close(db);
});

test('notify: discord_dm with empty allowlist → throws no_discord_target', async () => {
  Reflect.deleteProperty(process.env, 'DISCORD_ALLOWED_USER_IDS');
  const { db, capture } = await fresh();
  const { tool } = fakeDiscordTool();
  await assert.rejects(
    dispatchNotify({
      db,
      capture,
      name: 'foo',
      notify: 'discord_dm',
      output: 'x',
      tools: [tool],
      kind: 'success',
    }),
    /no discord notify target/,
  );
  await close(db);
});

test('notify: both — writes event AND calls discord_send', async () => {
  process.env.DISCORD_ALLOWED_USER_IDS = 'u1';
  const { db, capture } = await fresh();
  const { tool, calls } = fakeDiscordTool();
  await dispatchNotify({
    db,
    capture,
    name: 'foo',
    notify: 'both',
    output: 'msg',
    tools: [tool],
    kind: 'success',
  });
  assert.equal(calls.length, 1);
  const [rows] = await db.query("SELECT * FROM events WHERE source = 'job_output'").collect();
  assert.equal(rows.length, 1);
  Reflect.deleteProperty(process.env, 'DISCORD_ALLOWED_USER_IDS');
  await close(db);
});

test('notify: over-2000-char output truncated to 1996+…', async () => {
  process.env.DISCORD_ALLOWED_USER_IDS = 'u1';
  const { db, capture } = await fresh();
  const { tool, calls } = fakeDiscordTool();
  await dispatchNotify({
    db,
    capture,
    name: 'foo',
    notify: 'discord_dm',
    output: 'x'.repeat(5000),
    tools: [tool],
    kind: 'success',
  });
  assert.equal(calls[0].args.content.length, 2000);
  assert.match(calls[0].args.content, /…$/);
  Reflect.deleteProperty(process.env, 'DISCORD_ALLOWED_USER_IDS');
  await close(db);
});

test('notify failure path uses source=job_notification', async () => {
  const { db, capture } = await fresh();
  await dispatchNotify({
    db,
    capture: createCapture({
      db,
      embedder: createStubEmbedder({ dimension: 1024 }),
      source: 'job_notification',
      embed: false,
      mode: 'insert-or-skip',
    }),
    name: 'foo',
    notify: 'capture',
    output: '[foo] failed: boom',
    tools: [],
    kind: 'failure',
  });
  const [rows] = await db.query("SELECT * FROM events WHERE source = 'job_notification'").collect();
  assert.equal(rows.length, 1);
  await close(db);
});
```

- [ ] **Step 2: Run — fail**

```
node --test --test-force-exit tests/unit/jobs-notify.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// src/jobs/notify.js
const DISCORD_MAX = 2000;

function readAllowedUserIds() {
  return (process.env.DISCORD_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function truncateForDiscord(text) {
  if (text.length <= DISCORD_MAX) return text;
  return `${text.slice(0, DISCORD_MAX - 1)}…`;
}

export async function dispatchNotify({ db, capture, name, notify, output, tools, kind }) {
  const externalIdPrefix = `${name}:${new Date().toISOString()}`;
  const sendDiscord = notify === 'discord_dm' || notify === 'both';
  const sendCapture = notify === 'capture' || notify === 'both';

  if (sendDiscord) {
    const users = readAllowedUserIds();
    if (users.length === 0) {
      throw new Error('no discord notify target (DISCORD_ALLOWED_USER_IDS empty)');
    }
    const tool = tools.find((t) => t?.name === 'discord_send');
    if (!tool) throw new Error('discord_send tool not registered');
    const result = await tool.handler({
      action: 'send_dm',
      args: { user_id: users[0], content: truncateForDiscord(output) },
    });
    if (!result?.ok) {
      throw new Error(`discord_send refused: ${result?.reason ?? 'unknown'}`);
    }
  }

  if (sendCapture) {
    await capture([
      {
        source: kind === 'failure' ? 'job_notification' : 'job_output',
        content: output.slice(0, 4000),
        external_id: externalIdPrefix,
        meta: { job_name: name, kind },
      },
    ]);
  }
}
```

- [ ] **Step 4: Run — pass**

```
node --test --test-force-exit tests/unit/jobs-notify.test.js
```

Expected: 6 pass.

- [ ] **Step 5: Lint + commit**

```
npm run lint
git add src/jobs/notify.js tests/unit/jobs-notify.test.js
git commit -m "feat(4d): notify dispatch (discord_dm/capture/both/none, truncation, empty-allowlist)"
```

---

## Task 6: Job runner

Wraps the actual fire: timeout, runtime dispatch, success/failure, notification.

**Files:**
- Create: `src/jobs/runner.js`
- Test: `tests/unit/jobs-runner.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/jobs-runner.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import { upsertFromDiscovered } from '../../src/jobs/db.js';
import { runOneJob } from '../../src/jobs/runner.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function setup() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const capture = createCapture({
    db, embedder: createStubEmbedder({ dimension: 1024 }),
    source: 'job_output', embed: false, mode: 'insert-or-skip',
  });
  return { db, capture };
}

const SAMPLE_AGENT = {
  name: 'agent-job',
  schedule: '@daily',
  runtime: 'agent',
  enabled: true,
  catch_up: false,
  notify: 'capture',
  notify_on_failure: true,
  timeout_minutes: 1,
  manually_runnable: true,
  body: 'do the thing',
};

test('agent runtime — happy path captures job_output event', async () => {
  const { db, capture } = await setup();
  await upsertFromDiscovered(db, [SAMPLE_AGENT]);
  const host = { invokeLLM: async () => ({ content: 'hi from the LLM' }) };
  await runOneJob({ db, capture, host, jobs: [SAMPLE_AGENT], tools: [], name: 'agent-job' });
  const [rows] = await db.query("SELECT * FROM events WHERE source = 'job_output'").collect();
  assert.equal(rows.length, 1);
  await close(db);
});

test('agent runtime — timeout fails the job', async () => {
  const { db, capture } = await setup();
  await upsertFromDiscovered(db, [SAMPLE_AGENT]);
  const host = {
    invokeLLM: () => new Promise((resolve) => setTimeout(resolve, 5_000)),
  };
  // Override timeout to 50ms via job copy
  const fast = { ...SAMPLE_AGENT, timeout_minutes: 0.001 };
  await runOneJob({ db, capture, host, jobs: [fast], tools: [], name: 'agent-job' });
  const [rows] = await db.query("SELECT * FROM runtime_jobs WHERE name = 'agent-job'").collect();
  assert.equal(rows[0].last_run_ok, false);
  assert.match(rows[0].last_error, /timeout/);
  await close(db);
});

test('agent runtime — host throw fails the job and bumps consecutive_failures', async () => {
  const { db, capture } = await setup();
  await upsertFromDiscovered(db, [SAMPLE_AGENT]);
  const host = { invokeLLM: async () => { throw new Error('host went away'); } };
  await runOneJob({ db, capture, host, jobs: [SAMPLE_AGENT], tools: [], name: 'agent-job' });
  const [rows] = await db.query("SELECT * FROM runtime_jobs WHERE name = 'agent-job'").collect();
  assert.equal(rows[0].last_run_ok, false);
  assert.match(rows[0].last_error, /host went away/);
  assert.equal(rows[0].consecutive_failures, 1);
  await close(db);
});

test('internal runtime — dispatches to src/jobs/internal/<name>.js', async () => {
  // Use the test-fixture internal job we add for this test.
  const { db, capture } = await setup();
  const job = {
    name: 'test-internal-fixture',
    schedule: '@daily', runtime: 'internal',
    enabled: true, catch_up: false,
    notify: 'capture', notify_on_failure: true,
    timeout_minutes: 1, manually_runnable: true,
    body: '',
  };
  await upsertFromDiscovered(db, [job]);
  await runOneJob({ db, capture, host: null, jobs: [job], tools: [], name: 'test-internal-fixture' });
  const [rows] = await db.query("SELECT * FROM events WHERE source = 'job_output'").collect();
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, /from internal fixture/);
  await close(db);
});

test('notify_on_failure — failure with notify=capture writes job_notification event', async () => {
  const { db, capture } = await setup();
  await upsertFromDiscovered(db, [SAMPLE_AGENT]);
  const host = { invokeLLM: async () => { throw new Error('boom'); } };
  await runOneJob({ db, capture, host, jobs: [SAMPLE_AGENT], tools: [], name: 'agent-job' });
  const [rows] = await db.query("SELECT * FROM events WHERE source = 'job_notification'").collect();
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, /failed: boom/);
  await close(db);
});
```

Also create the fixture this test depends on:

```js
// src/jobs/internal/test-internal-fixture.js
export default async function testInternalFixture({ db, host, capture }) {
  return 'from internal fixture';
}
```

- [ ] **Step 2: Run — fail**

```
node --test --test-force-exit tests/unit/jobs-runner.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement the runner**

```js
// src/jobs/runner.js
import { dispatchNotify } from './notify.js';
import { recordFailure, recordSuccess, setInFlight } from './db.js';
import { parseCron, nextFire } from './cron.js';

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function dispatchRuntime({ job, db, host, capture, tools }) {
  if (job.runtime === 'agent') {
    if (!host?.invokeLLM) throw new Error('agent runtime needs a host with invokeLLM');
    const llm = await host.invokeLLM(
      [{ role: 'user', content: job.body }],
      { tier: 'deep' },
    );
    return (llm?.content ?? '').toString();
  }
  if (job.runtime === 'internal') {
    const mod = await import(new URL(`./internal/${job.name}.js`, import.meta.url));
    const fn = mod.default;
    if (typeof fn !== 'function') throw new Error(`internal job ${job.name}: no default export`);
    const out = await fn({ db, host, capture, tools });
    return out == null ? null : String(out);
  }
  throw new Error(`unknown runtime: ${job.runtime}`);
}

export async function runOneJob({ db, capture, host, jobs, tools, name, now = () => new Date() }) {
  const job = jobs.find((j) => j.name === name);
  if (!job) throw new Error(`job not found: ${name}`);
  const start = Date.now();
  await setInFlight(db, name, true);

  let parsed;
  try {
    parsed = parseCron(job.schedule);
  } catch (e) {
    await recordFailure(db, name, {
      error: `bad schedule: ${e.message}`,
      duration_ms: Date.now() - start,
      next_run_at: null,
    });
    return;
  }

  const timeoutMs = Math.max(100, Math.floor(job.timeout_minutes * 60_000));
  try {
    const output = await withTimeout(
      dispatchRuntime({ job, db, host, capture, tools }),
      timeoutMs,
    );
    const next_run_at = nextFire(parsed, now());
    await recordSuccess(db, name, {
      duration_ms: Date.now() - start,
      next_run_at,
    });
    if (job.notify !== 'none' && output != null && output.length > 0) {
      try {
        await dispatchNotify({
          db, capture, name, notify: job.notify, output, tools, kind: 'success',
        });
      } catch (e) {
        console.warn(`[jobs] ${name}: notify failed: ${e.message}`);
      }
    }
  } catch (e) {
    const next_run_at = nextFire(parsed, now());
    await recordFailure(db, name, {
      error: e.message,
      duration_ms: Date.now() - start,
      next_run_at,
    });
    if (job.notify_on_failure) {
      try {
        await dispatchNotify({
          db, capture, name,
          notify: job.notify === 'none' ? 'capture' : job.notify,
          output: `[${name}] failed: ${e.message}`,
          tools, kind: 'failure',
        });
      } catch (notifyErr) {
        console.warn(`[jobs] ${name}: failure-notify failed: ${notifyErr.message}`);
      }
    }
  }
}
```

- [ ] **Step 4: Run — pass**

```
node --test --test-force-exit tests/unit/jobs-runner.test.js
```

Expected: 5 pass.

- [ ] **Step 5: Lint + commit**

```
npm run lint
git add src/jobs/runner.js src/jobs/internal/test-internal-fixture.js tests/unit/jobs-runner.test.js
git commit -m "feat(4d): job runner (agent+internal runtimes, timeout, notify hooks)"
```

---

## Task 7: Scheduler extension

`listDueJobs(db, jobs)` + `planNextRunAt(db, jobs)` + integration with the existing `createScheduler`.

**Files:**
- Create: `src/jobs/scheduler-ext.js`
- Test: `tests/unit/jobs-scheduler-ext.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/jobs-scheduler-ext.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { setEnabled, upsertFromDiscovered } from '../../src/jobs/db.js';
import { listDueJobs, planNextRunAt } from '../../src/jobs/scheduler-ext.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

const JOB = (over = {}) => ({
  name: 'foo',
  schedule: '@hourly',
  runtime: 'agent',
  enabled: true,
  catch_up: false,
  notify: 'capture',
  notify_on_failure: true,
  timeout_minutes: 10,
  manually_runnable: true,
  ...over,
});

test('planNextRunAt — first fire with catch_up:false uses nextFire', async () => {
  const db = await fresh();
  const j = JOB({ catch_up: false });
  await upsertFromDiscovered(db, [j]);
  const now = new Date('2026-05-10T12:34:00.000Z');
  await planNextRunAt(db, [j], now);
  const [rows] = await db.query("SELECT * FROM runtime_jobs WHERE name = 'foo'").collect();
  // @hourly = "0 * * * *" → next is 13:00:00
  assert.equal(rows[0].next_run_at.toISOString(), '2026-05-10T13:00:00.000Z');
  await close(db);
});

test('planNextRunAt — first fire with catch_up:true sets next_run_at = now', async () => {
  const db = await fresh();
  const j = JOB({ catch_up: true });
  await upsertFromDiscovered(db, [j]);
  const now = new Date('2026-05-10T12:34:00.000Z');
  await planNextRunAt(db, [j], now);
  const [rows] = await db.query("SELECT * FROM runtime_jobs WHERE name = 'foo'").collect();
  assert.equal(rows[0].next_run_at.toISOString(), now.toISOString());
  await close(db);
});

test('listDueJobs — returns enabled jobs with next_run_at <= now and not in_flight', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [JOB({ name: 'a' }), JOB({ name: 'b' }), JOB({ name: 'c' })]);
  const now = new Date('2026-05-10T13:00:00.000Z');
  // a: due now
  await db.query(`UPDATE runtime_jobs MERGE { next_run_at: d'2026-05-10T12:59:00Z' } WHERE name = 'a'`).collect();
  // b: due now but in_flight
  await db.query(`UPDATE runtime_jobs MERGE { next_run_at: d'2026-05-10T12:59:00Z', in_flight: true } WHERE name = 'b'`).collect();
  // c: not due
  await db.query(`UPDATE runtime_jobs MERGE { next_run_at: d'2026-05-10T14:00:00Z' } WHERE name = 'c'`).collect();
  const due = await listDueJobs(db, now);
  assert.deepEqual(due, [{ name: 'a', kind: 'job' }]);
  await close(db);
});

test('listDueJobs — skips disabled jobs', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [JOB({ name: 'a' })]);
  await setEnabled(db, 'a', false);
  await db.query(`UPDATE runtime_jobs MERGE { next_run_at: time::now() - 1m } WHERE name = 'a'`).collect();
  const due = await listDueJobs(db, new Date());
  assert.deepEqual(due, []);
  await close(db);
});
```

- [ ] **Step 2: Run — fail**

```
node --test --test-force-exit tests/unit/jobs-scheduler-ext.test.js
```

- [ ] **Step 3: Implement**

```js
// src/jobs/scheduler-ext.js
import { surql } from 'surrealdb';
import { getJob, listAllJobs, setNextRunAt } from './db.js';
import { expectedIntervalMs, nextFire, parseCron } from './cron.js';

const CATCHUP_FACTOR = 1.5;

export async function planNextRunAt(db, jobs, now = new Date()) {
  for (const j of jobs) {
    const row = await getJob(db, j.name);
    if (!row || !row.enabled) continue;
    let parsed;
    try {
      parsed = parseCron(j.schedule);
    } catch (e) {
      console.warn(`[jobs] ${j.name}: bad schedule '${j.schedule}': ${e.message}`);
      continue;
    }

    const lastRunAt = row.last_run_at ? new Date(row.last_run_at) : null;

    if (lastRunAt == null) {
      // First-ever fire.
      const target = j.catch_up ? new Date(now) : nextFire(parsed, now);
      await setNextRunAt(db, j.name, target);
      continue;
    }

    const intervalMs = expectedIntervalMs(parsed, now);
    const behindMs = now.getTime() - lastRunAt.getTime();
    if (behindMs > CATCHUP_FACTOR * intervalMs && j.catch_up) {
      await setNextRunAt(db, j.name, new Date(now));
    } else if (!row.next_run_at) {
      await setNextRunAt(db, j.name, nextFire(parsed, now));
    }
  }
}

export async function listDueJobs(db, now = new Date()) {
  const [rows] = await db
    .query(
      surql`SELECT name FROM runtime_jobs
            WHERE enabled = true AND in_flight = false AND next_run_at <= ${now}
            ORDER BY name`,
    )
    .collect();
  return (rows ?? []).map((r) => ({ name: r.name, kind: 'job' }));
}
```

- [ ] **Step 4: Run — pass**

```
node --test --test-force-exit tests/unit/jobs-scheduler-ext.test.js
```

- [ ] **Step 5: Lint + commit**

```
npm run lint
git add src/jobs/scheduler-ext.js tests/unit/jobs-scheduler-ext.test.js
git commit -m "feat(4d): scheduler extension (listDueJobs, planNextRunAt, catch-up)"
```

---

## Task 8: Daemon boot wiring

Wire jobs into the daemon's scheduler factory + register MCP tools + add `/internal/jobs/run` endpoint.

**Files:**
- Modify: `src/daemon/server.js` (additive — find existing scheduler/MCP tool registration sites)

- [ ] **Step 1: Read the current daemon server file**

```
grep -n "createScheduler\|tools.push\|integrationsStatus\|/internal/" src/daemon/server.js | head -20
```

Identify (a) where `createScheduler` is called, (b) where MCP tools are pushed into `tools[]`, (c) where existing `/internal/*` endpoints are registered.

- [ ] **Step 2: Add jobs imports + discovery at daemon boot**

Near the top of `src/daemon/server.js` (after existing imports):

```js
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { discoverJobs } from '../jobs/loader.js';
import { upsertFromDiscovered, garbageCollect, getJob } from '../jobs/db.js';
import { listDueJobs, planNextRunAt } from '../jobs/scheduler-ext.js';
import { runOneJob } from '../jobs/runner.js';
import { createListJobsTool } from '../mcp/tools/list-jobs.js';
import { createRunJobTool } from '../mcp/tools/run-job.js';

const BUILTIN_JOBS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'jobs',
  'builtin',
);
```

In the boot path, after the existing dream-cursor seed block and before the `tools = [...]` array, add:

```js
// Phase 4d — discover jobs (built-in + user) and UPSERT into runtime_jobs.
{
  const userJobsDir = join(p.home, 'jobs');
  const jobsCache = { current: [] };
  const refreshJobs = async () => {
    jobsCache.current = discoverJobs({
      builtinDir: BUILTIN_JOBS_DIR,
      userDir: userJobsDir,
    });
    await upsertFromDiscovered(dbHandle, jobsCache.current);
    await garbageCollect(dbHandle, new Set(jobsCache.current.map((j) => j.name)));
    await planNextRunAt(dbHandle, jobsCache.current);
  };
  await refreshJobs();
  // Expose to closures below
  globalThis.__robinJobsRefresh = refreshJobs;       // see step 4 use
  globalThis.__robinJobsCache = jobsCache;
}
```

(The `globalThis` stash is module-scope-shaped and avoids passing two new closures through to the scheduler factory; we'll remove it in a follow-up refactor if it stays awkward.)

- [ ] **Step 3: Add jobs MCP tools to the tools array**

In the `tools = [...]` block where existing tools are pushed, after the integration-related tools, add:

```js
createListJobsTool({ db: dbHandle }),
createRunJobTool({
  db: dbHandle,
  capture: createCapture({           // job_output / job_notification source
    db: dbHandle,
    embedder: embedderWrap,
    source: 'job_output',
    embed: false,
    mode: 'insert-or-skip',
  }),
  host,
  tools: () => tools,                 // late-bound — tools array isn't fully populated yet at construction
  getJobs: () => globalThis.__robinJobsCache.current,
}),
```

(`createCapture` is already imported from `../integrations/_framework/capture.js` elsewhere in this file; if not, add the import.)

- [ ] **Step 4: Extend the scheduler factory to dispatch jobs**

Find the call to `createScheduler({ listDue, runOne, isOverflow })`. Wrap the existing `listDue` / `runOne` to ALSO survey + dispatch jobs:

```js
const baseListDue = /* existing listDue closure */;
const baseRunOne  = /* existing runOne closure */;

scheduler = createScheduler({
  listDue: async () => {
    // Refresh jobs from disk so dropped-in markdown is picked up.
    await globalThis.__robinJobsRefresh();
    const integrationsAndDream = await baseListDue();
    const jobs = await listDueJobs(dbHandle, new Date());
    // Integrations + dream first, then jobs.
    return [...integrationsAndDream, ...jobs];
  },
  runOne: async (name) => {
    const job = globalThis.__robinJobsCache.current.find((j) => j.name === name);
    if (job) {
      const captureForJob = createCapture({
        db: dbHandle, embedder: embedderWrap,
        source: 'job_output', embed: false, mode: 'insert-or-skip',
      });
      await runOneJob({
        db: dbHandle, capture: captureForJob, host,
        jobs: globalThis.__robinJobsCache.current, tools, name,
      });
      // Re-plan after the run.
      await planNextRunAt(dbHandle, globalThis.__robinJobsCache.current);
      return;
    }
    return baseRunOne(name);
  },
  isOverflow,
  heartbeatMs: 60_000,
});
```

(Don't change `isOverflow` or `heartbeatMs` if they were already set differently — preserve existing values.)

- [ ] **Step 5: Add `/internal/jobs/run` endpoint**

In the daemon's HTTP handler (search for the existing `/internal/auto-recall` or `/internal/session/register` routes), add:

```js
if (url.pathname === '/internal/jobs/run' && req.method === 'POST') {
  const body = await readJsonBody(req);
  const name = body?.name;
  const force = body?.force === true;
  if (!name) return json(res, 400, { ok: false, reason: 'missing name' });
  const row = await getJob(dbHandle, name);
  if (!row) return json(res, 404, { ok: false, reason: 'job not found' });
  if (row.in_flight && !force) {
    return json(res, 409, { ok: false, reason: 'in_flight' });
  }
  if (row.manually_runnable === false && !force) {
    return json(res, 403, { ok: false, reason: 'not_manually_runnable' });
  }
  // Fire (await — call site already returned to client at this point because
  // scheduler runs in parallel; for the /internal call we want the result).
  const captureForJob = createCapture({
    db: dbHandle, embedder: embedderWrap,
    source: 'job_output', embed: false, mode: 'insert-or-skip',
  });
  await runOneJob({
    db: dbHandle, capture: captureForJob, host,
    jobs: globalThis.__robinJobsCache.current, tools, name,
  });
  const after = await getJob(dbHandle, name);
  return json(res, 200, { ok: after.last_run_ok === true, last_error: after.last_error ?? null });
}
```

Match the existing `readJsonBody` / `json` helper names in this file — if they're called differently (e.g. `parseBody`, `sendJson`), use those.

- [ ] **Step 6: Run the daemon unit + existing integration tests to catch wiring regressions**

```
node --test --test-force-exit tests/integration/mcp-end-to-end.test.js tests/integration/scheduler-multi-integration.test.js
```

Expected: still passing. Investigate any new failure before continuing.

- [ ] **Step 7: Lint + commit**

```
npm run lint
git add src/daemon/server.js
git commit -m "feat(4d): daemon wires jobs into scheduler + MCP + /internal endpoint"
```

---

## Task 9: CLI — `robin jobs list` + `status`

**Files:**
- Create: `src/cli/commands/jobs-list.js`, `src/cli/commands/jobs-status.js`
- Modify: `src/cli/index.js`
- Test: `tests/unit/jobs-cli.test.js` (shared with Task 10)

- [ ] **Step 1: Write the failing list/status portion of jobs-cli.test.js**

```js
// tests/unit/jobs-cli.test.js  (this file grows in tasks 9 and 10)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const { jobsList } = await import('../../src/cli/commands/jobs-list.js');
const { jobsStatus } = await import('../../src/cli/commands/jobs-status.js');

function capture() {
  const lines = [];
  return { lines, fn: (s) => lines.push(s) };
}

test('jobs list — prints header line + (no jobs) when DB empty', async () => {
  const out = capture();
  await jobsList([], { out: out.fn, listJobs: async () => [] });
  assert.match(out.lines.join('\n'), /\(no jobs\)/);
});

test('jobs list — formats columns', async () => {
  const out = capture();
  await jobsList([], {
    out: out.fn,
    listJobs: async () => [
      { name: 'foo', enabled: true, schedule: '@daily', last_run_at: null, last_run_ok: null, next_run_at: new Date('2026-05-10T14:00:00Z') },
      { name: 'bar', enabled: false, schedule: '@hourly', last_run_at: new Date('2026-05-10T12:00:00Z'), last_run_ok: true, next_run_at: null },
    ],
  });
  const all = out.lines.join('\n');
  assert.match(all, /foo\s+enabled\s+@daily/);
  assert.match(all, /bar\s+disabled\s+@hourly/);
});

test('jobs status — prints all DB fields', async () => {
  const out = capture();
  await jobsStatus(['foo'], {
    out: out.fn,
    getJob: async () => ({
      name: 'foo',
      enabled: true,
      schedule: '@daily',
      runtime: 'agent',
      last_run_at: new Date('2026-05-10T14:00:00Z'),
      last_run_ok: true,
      last_error: null,
      last_duration_ms: 1234,
      next_run_at: new Date('2026-05-11T14:00:00Z'),
      consecutive_failures: 0,
      in_flight: false,
      manually_runnable: true,
    }),
  });
  const all = out.lines.join('\n');
  assert.match(all, /name: foo/);
  assert.match(all, /enabled: true/);
  assert.match(all, /runtime: agent/);
  assert.match(all, /consecutive_failures: 0/);
});

test('jobs status — unknown job', async () => {
  const out = capture();
  const err = capture();
  await jobsStatus(['nope'], { out: out.fn, err: err.fn, getJob: async () => null });
  assert.match(err.lines.join('\n'), /no such job: nope/);
});
```

- [ ] **Step 2: Run — fail**

```
node --test --test-force-exit tests/unit/jobs-cli.test.js
```

- [ ] **Step 3: Implement jobs-list and jobs-status**

```js
// src/cli/commands/jobs-list.js
import { close, connect } from '../../db/client.js';
import { listAllJobs } from '../../jobs/db.js';
import { ensureHome, paths } from '../../runtime/home.js';

function fmt(d) {
  return d ? new Date(d).toISOString() : '—';
}

export async function jobsList(_argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const list = deps.listJobs ?? (async () => {
    await ensureHome();
    const p = paths();
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      return await listAllJobs(db);
    } finally {
      await close(db);
    }
  });
  const jobs = await list();
  if (jobs.length === 0) {
    out('(no jobs)');
    return;
  }
  out(`name             status     schedule         last-run                 next-run                 ok`);
  for (const j of jobs) {
    const ok = j.last_run_ok === true ? 'OK' : j.last_run_ok === false ? 'FAIL' : '—';
    out(
      `${j.name.padEnd(16)} ${(j.enabled ? 'enabled' : 'disabled').padEnd(10)} ${(j.schedule ?? '').padEnd(16)} ${fmt(j.last_run_at).padEnd(24)} ${fmt(j.next_run_at).padEnd(24)} ${ok}`,
    );
  }
}
```

```js
// src/cli/commands/jobs-status.js
import { close, connect } from '../../db/client.js';
import { getJob } from '../../jobs/db.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function jobsStatus(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const name = argv[0];
  if (!name) {
    err('usage: robin jobs status <name>');
    process.exitCode = 1;
    return;
  }
  const fetch = deps.getJob ?? (async (n) => {
    await ensureHome();
    const p = paths();
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      return await getJob(db, n);
    } finally {
      await close(db);
    }
  });
  const row = await fetch(name);
  if (!row) {
    err(`no such job: ${name}`);
    process.exitCode = 1;
    return;
  }
  const fields = [
    'name', 'enabled', 'schedule', 'runtime', 'manually_runnable',
    'last_run_at', 'last_run_ok', 'last_error', 'last_duration_ms',
    'next_run_at', 'consecutive_failures', 'in_flight',
  ];
  for (const f of fields) {
    const v = row[f];
    out(`${f}: ${v instanceof Date ? v.toISOString() : v}`);
  }
}
```

- [ ] **Step 4: Wire the dispatcher**

Edit `src/cli/index.js` — add a `jobs` block alongside the existing `integrations` block:

```js
if (cmd === 'jobs') {
  const sub = argv[1];
  if (sub === 'list') {
    const { jobsList } = await import('./commands/jobs-list.js');
    return jobsList(argv.slice(2));
  }
  if (sub === 'status') {
    const { jobsStatus } = await import('./commands/jobs-status.js');
    return jobsStatus(argv.slice(2));
  }
  if (sub === 'run') {
    const { jobsRun } = await import('./commands/jobs-run.js');
    return jobsRun(argv.slice(2));
  }
  if (sub === 'enable') {
    const { jobsEnable } = await import('./commands/jobs-enable.js');
    return jobsEnable(argv.slice(2));
  }
  if (sub === 'disable') {
    const { jobsDisable } = await import('./commands/jobs-disable.js');
    return jobsDisable(argv.slice(2));
  }
  if (sub === 'reload') {
    const { jobsReload } = await import('./commands/jobs-reload.js');
    return jobsReload(argv.slice(2));
  }
  console.error('usage: robin jobs <list|status|run|enable|disable|reload>');
  process.exit(1);
}
```

- [ ] **Step 5: Run — pass**

```
node --test --test-force-exit tests/unit/jobs-cli.test.js
```

- [ ] **Step 6: Lint + commit**

```
npm run lint
git add src/cli/commands/jobs-list.js src/cli/commands/jobs-status.js src/cli/index.js tests/unit/jobs-cli.test.js
git commit -m "feat(4d): robin jobs list + status CLI"
```

---

## Task 10: CLI — `robin jobs run|enable|disable|reload`

**Files:**
- Create: `src/cli/commands/jobs-{run,enable,disable,reload}.js`
- Modify: `tests/unit/jobs-cli.test.js` (append)

- [ ] **Step 1: Append failing tests**

```js
// tests/unit/jobs-cli.test.js  (additions)
import { jobsRun } from '../../src/cli/commands/jobs-run.js';
import { jobsEnable } from '../../src/cli/commands/jobs-enable.js';
import { jobsDisable } from '../../src/cli/commands/jobs-disable.js';
import { jobsReload } from '../../src/cli/commands/jobs-reload.js';

test('jobs run — POSTs to /internal/jobs/run', async () => {
  const out = capture();
  let posted;
  await jobsRun(['foo'], {
    out: out.fn,
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return { ok: true, last_error: null };
    },
  });
  assert.equal(posted.path, '/internal/jobs/run');
  assert.deepEqual(posted.body, { name: 'foo', force: false });
  assert.match(out.lines.join('\n'), /ok/);
});

test('jobs run --force passes force=true', async () => {
  let posted;
  await jobsRun(['foo', '--force'], {
    out: () => {},
    daemonRequest: async (path, body) => {
      posted = body;
      return { ok: true };
    },
  });
  assert.equal(posted.force, true);
});

test('jobs run reports not_manually_runnable as ok=false', async () => {
  const out = capture();
  const err = capture();
  await jobsRun(['heavy'], {
    out: out.fn, err: err.fn,
    daemonRequest: async () => ({ ok: false, reason: 'not_manually_runnable' }),
  });
  assert.match(err.lines.join('\n'), /not_manually_runnable/);
});

test('jobs enable/disable call setEnabled', async () => {
  const calls = [];
  await jobsEnable(['foo'], { setEnabled: async (n, v) => calls.push([n, v]), out: () => {} });
  await jobsDisable(['foo'], { setEnabled: async (n, v) => calls.push([n, v]), out: () => {} });
  assert.deepEqual(calls, [['foo', true], ['foo', false]]);
});

test('jobs reload triggers /internal/jobs/reload', async () => {
  let hit;
  await jobsReload([], {
    daemonRequest: async (path) => { hit = path; return { ok: true, count: 3 }; },
    out: () => {},
  });
  assert.equal(hit, '/internal/jobs/reload');
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement the four CLIs**

```js
// src/cli/commands/jobs-run.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function jobsRun(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;
  const name = argv[0];
  if (!name) {
    err('usage: robin jobs run <name> [--force]');
    process.exitCode = 1;
    return;
  }
  const force = argv.includes('--force');
  const result = await request('/internal/jobs/run', { name, force });
  if (result?.ok) {
    out(`ok${result.last_error ? ` (warn: ${result.last_error})` : ''}`);
  } else {
    err(`run failed: reason=${result?.reason ?? 'unknown'}${result?.last_error ? ` (${result.last_error})` : ''}`);
    process.exitCode = 1;
  }
}
```

```js
// src/cli/commands/jobs-enable.js
import { close, connect } from '../../db/client.js';
import { setEnabled } from '../../jobs/db.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function jobsEnable(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const name = argv[0];
  if (!name) {
    console.error('usage: robin jobs enable <name>');
    process.exitCode = 1;
    return;
  }
  const set = deps.setEnabled ?? (async (n, v) => {
    await ensureHome();
    const p = paths();
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try { await setEnabled(db, n, v); } finally { await close(db); }
  });
  await set(name, true);
  out(`enabled ${name}`);
}
```

```js
// src/cli/commands/jobs-disable.js
import { close, connect } from '../../db/client.js';
import { setEnabled } from '../../jobs/db.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function jobsDisable(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const name = argv[0];
  if (!name) {
    console.error('usage: robin jobs disable <name>');
    process.exitCode = 1;
    return;
  }
  const set = deps.setEnabled ?? (async (n, v) => {
    await ensureHome();
    const p = paths();
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try { await setEnabled(db, n, v); } finally { await close(db); }
  });
  await set(name, false);
  out(`disabled ${name}`);
}
```

```js
// src/cli/commands/jobs-reload.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function jobsReload(_argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;
  const result = await request('/internal/jobs/reload');
  if (result?.ok) {
    out(`reloaded — ${result.count ?? 0} jobs discovered`);
  } else {
    err(`reload failed: ${result?.reason ?? 'unknown'}`);
    process.exitCode = 1;
  }
}
```

If `../daemon-request.js` doesn't exist yet, create it as a thin POST helper:

```js
// src/cli/daemon-request.js
import { readDaemonState } from '../daemon/state.js';
import { paths } from '../runtime/home.js';

export async function daemonRequest(path, body) {
  const state = await readDaemonState(paths().daemonState);
  if (!state?.port) throw new Error('daemon not running');
  const res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}
```

Also add the `/internal/jobs/reload` endpoint to `src/daemon/server.js`:

```js
if (url.pathname === '/internal/jobs/reload' && req.method === 'POST') {
  await globalThis.__robinJobsRefresh();
  const count = globalThis.__robinJobsCache.current.length;
  return json(res, 200, { ok: true, count });
}
```

- [ ] **Step 4: Run — pass**

```
node --test --test-force-exit tests/unit/jobs-cli.test.js
```

- [ ] **Step 5: Lint + commit**

```
npm run lint
git add src/cli/commands/jobs-run.js src/cli/commands/jobs-enable.js src/cli/commands/jobs-disable.js src/cli/commands/jobs-reload.js src/cli/daemon-request.js src/daemon/server.js tests/unit/jobs-cli.test.js
git commit -m "feat(4d): robin jobs run/enable/disable/reload CLI + /internal/jobs/reload"
```

---

## Task 11: MCP tools `list_jobs` + `run_job`

**Files:**
- Create: `src/mcp/tools/list-jobs.js`, `src/mcp/tools/run-job.js`
- Test: `tests/unit/jobs-mcp.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/jobs-mcp.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import { upsertFromDiscovered } from '../../src/jobs/db.js';
import { createListJobsTool } from '../../src/mcp/tools/list-jobs.js';
import { createRunJobTool } from '../../src/mcp/tools/run-job.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

const SAMPLE = (over = {}) => ({
  name: 'foo',
  schedule: '@daily',
  runtime: 'agent',
  enabled: true,
  catch_up: false,
  notify: 'capture',
  notify_on_failure: true,
  timeout_minutes: 1,
  manually_runnable: true,
  body: 'hi',
  ...over,
});

test('list_jobs — returns shape with subset of fields', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE()]);
  const tool = createListJobsTool({ db });
  const r = await tool.handler({});
  assert.ok(Array.isArray(r.jobs));
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].name, 'foo');
  assert.equal(r.jobs[0].manually_runnable, true);
  await close(db);
});

test('list_jobs — filter enabled=false hides enabled jobs', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE(), SAMPLE({ name: 'bar', enabled: false })]);
  const tool = createListJobsTool({ db });
  const r = await tool.handler({ filter: { enabled: false } });
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].name, 'bar');
  await close(db);
});

test('run_job — refuses not_manually_runnable', async () => {
  const db = await fresh();
  const job = SAMPLE({ manually_runnable: false });
  await upsertFromDiscovered(db, [job]);
  const tool = createRunJobTool({
    db,
    host: { invokeLLM: async () => ({ content: 'x' }) },
    capture: createCapture({ db, embedder: createStubEmbedder({ dimension: 1024 }), source: 'job_output', embed: false, mode: 'insert-or-skip' }),
    tools: () => [],
    getJobs: () => [job],
  });
  const r = await tool.handler({ name: 'foo' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_manually_runnable');
  await close(db);
});

test('run_job — dry_run validates without dispatching', async () => {
  const db = await fresh();
  const job = SAMPLE();
  await upsertFromDiscovered(db, [job]);
  let llmCalled = false;
  const tool = createRunJobTool({
    db,
    host: { invokeLLM: async () => { llmCalled = true; return { content: 'x' }; } },
    capture: createCapture({ db, embedder: createStubEmbedder({ dimension: 1024 }), source: 'job_output', embed: false, mode: 'insert-or-skip' }),
    tools: () => [],
    getJobs: () => [job],
  });
  const r = await tool.handler({ name: 'foo', dry_run: true });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true);
  assert.equal(llmCalled, false);
  await close(db);
});

test('run_job — happy path', async () => {
  const db = await fresh();
  const job = SAMPLE();
  await upsertFromDiscovered(db, [job]);
  const tool = createRunJobTool({
    db,
    host: { invokeLLM: async () => ({ content: 'morning' }) },
    capture: createCapture({ db, embedder: createStubEmbedder({ dimension: 1024 }), source: 'job_output', embed: false, mode: 'insert-or-skip' }),
    tools: () => [],
    getJobs: () => [job],
  });
  const r = await tool.handler({ name: 'foo' });
  assert.equal(r.ok, true);
  await close(db);
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement the two tools**

```js
// src/mcp/tools/list-jobs.js
import { listAllJobs } from '../../jobs/db.js';

const FIELDS = [
  'name', 'enabled', 'schedule', 'runtime', 'manually_runnable',
  'last_run_at', 'last_run_ok', 'next_run_at', 'consecutive_failures',
];

export function createListJobsTool({ db }) {
  return {
    name: 'list_jobs',
    description: 'List jobs known to the runner.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
    handler: async (input) => {
      const all = await listAllJobs(db);
      const filtered =
        input?.filter && typeof input.filter.enabled === 'boolean'
          ? all.filter((j) => j.enabled === input.filter.enabled)
          : all;
      const jobs = filtered.map((j) => {
        const out = {};
        for (const f of FIELDS) out[f] = j[f] ?? null;
        return out;
      });
      return { jobs };
    },
  };
}
```

```js
// src/mcp/tools/run-job.js
import { getJob } from '../../jobs/db.js';
import { runOneJob } from '../../jobs/runner.js';

export function createRunJobTool({ db, capture, host, tools, getJobs }) {
  return {
    name: 'run_job',
    description: 'Trigger a job manually. Refuses jobs declared manually_runnable: false.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        dry_run: { type: 'boolean' },
      },
      required: ['name'],
    },
    handler: async ({ name, dry_run }) => {
      const row = await getJob(db, name);
      if (!row) return { ok: false, reason: 'job_not_found' };
      if (row.manually_runnable === false) return { ok: false, reason: 'not_manually_runnable' };
      if (row.in_flight) return { ok: false, reason: 'in_flight' };
      if (dry_run) return { ok: true, dry_run: true };
      await runOneJob({
        db, capture, host,
        jobs: getJobs(),
        tools: typeof tools === 'function' ? tools() : tools,
        name,
      });
      const after = await getJob(db, name);
      return {
        ok: after.last_run_ok === true,
        last_error: after.last_error ?? null,
      };
    },
  };
}
```

- [ ] **Step 4: Run — pass**

```
node --test --test-force-exit tests/unit/jobs-mcp.test.js
```

- [ ] **Step 5: Lint + commit**

```
npm run lint
git add src/mcp/tools/list-jobs.js src/mcp/tools/run-job.js tests/unit/jobs-mcp.test.js
git commit -m "feat(4d): list_jobs + run_job MCP tools (manually_runnable gate)"
```

---

## Task 12: Built-in `daily-briefing.md`

**Files:**
- Create: `src/jobs/builtin/daily-briefing.md`
- Create: `src/jobs/internal/.gitkeep` (placeholder so the dir is checked in)

- [ ] **Step 1: Write the daily-briefing markdown**

```markdown
---
name: daily-briefing
schedule: "0 7 * * *"
runtime: agent
enabled: false
catch_up: true
timeout_minutes: 15
notify: both
notify_on_failure: true
manually_runnable: true
description: Morning brief — calendar, mail, corrections, open work.
---

You are Robin's daily briefing assistant. Produce a concise morning summary for the user covering:

1. **Today's calendar** — call `calendar_list_events` for events in the next 14 hours; group by morning/afternoon/evening; paraphrase event titles (never quote verbatim).

2. **Mail that needs attention** — call `gmail_search` for unread messages with importance markers (starred, "important" label, or from frequent correspondents). Surface the sender + paraphrased subject. Skip newsletters and obvious notifications.

3. **Corrections to follow up on** — call `recall(query="recent correction")` filtered to the last 7 days. If any are unresolved (no follow-up action visible in recent events), call them out.

4. **Open work** — call `linear` recent activity, filter to issues assigned to the user without recent updates. Cap at 5.

Format as a tight bulleted list. Total length ≤ 1500 characters. Never copy untrusted-source text verbatim; always paraphrase. If any integration returns `not_authenticated` or `unavailable`, skip that section and add a single line at the end noting which sources were unavailable.

End with one suggested first action — a single sentence pointing at the highest-leverage thing for the morning.
```

- [ ] **Step 2: Add the .gitkeep**

```
mkdir -p src/jobs/internal
touch src/jobs/internal/.gitkeep
```

- [ ] **Step 3: Smoke-test discovery**

Add a quick test in `tests/unit/jobs-loader.test.js`:

```js
test('discoverJobs — picks up shipped daily-briefing built-in', async () => {
  const { discoverJobs } = await import('../../src/jobs/loader.js');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const builtinDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'src',
    'jobs',
    'builtin',
  );
  const jobs = discoverJobs({ builtinDir, userDir: '/nonexistent' });
  const briefing = jobs.find((j) => j.name === 'daily-briefing');
  assert.ok(briefing, 'daily-briefing should be discovered');
  assert.equal(briefing.runtime, 'agent');
  assert.equal(briefing.enabled, false);
});
```

- [ ] **Step 4: Run — passes**

```
node --test --test-force-exit tests/unit/jobs-loader.test.js
```

- [ ] **Step 5: Commit**

```
git add src/jobs/builtin/daily-briefing.md src/jobs/internal/.gitkeep tests/unit/jobs-loader.test.js
git commit -m "feat(4d): daily-briefing built-in markdown + internal/ placeholder"
```

---

## Task 13: AGENTS.md jobs section + regenerator wiring

**Files:**
- Modify: `src/install/agents-md.js`
- Modify: `src/cli/commands/mcp-install.js`
- Test: `tests/unit/agents-md-jobs.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/agents-md-jobs.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../src/install/agents-md.js';

test('agentsMdContent — robin-jobs block present when jobs array provided', () => {
  const md = agentsMdContent({
    jobs: [
      { name: 'daily-briefing', enabled: false, schedule: '0 7 * * *', next_run_at: null, manually_runnable: true },
      { name: 'foo', enabled: true, schedule: '@hourly', next_run_at: new Date('2026-05-10T14:00:00Z'), manually_runnable: true },
    ],
  });
  assert.match(md, /<!-- robin-jobs:start/);
  assert.match(md, /<!-- robin-jobs:end -->/);
  assert.match(md, /daily-briefing\s+disabled/);
  assert.match(md, /foo\s+enabled/);
});

test('agentsMdContent — fallback message when jobs array missing', () => {
  const md = agentsMdContent({});
  assert.match(md, /<!-- robin-jobs:start/);
  assert.match(md, /jobs surface unavailable/);
});

test('agentsMdContent — run_job usage caveat present', () => {
  const md = agentsMdContent({ jobs: [] });
  assert.match(md, /run_job/);
  assert.match(md, /user request/i);
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement the section**

Add to `src/install/agents-md.js`:

```js
function renderJobsList(jobs) {
  if (!Array.isArray(jobs)) return '(jobs surface unavailable — daemon not initialized)';
  if (jobs.length === 0) return '(no jobs registered)';
  return jobs.map((j) => {
    const status = j.enabled ? 'enabled' : 'disabled';
    const next = j.next_run_at ? new Date(j.next_run_at).toISOString() : '—';
    return `- ${j.name.padEnd(20)} ${status.padEnd(9)} ${(j.schedule ?? '').padEnd(16)} next=${next}`;
  }).join('\n');
}

export function jobsSection(jobs) {
  return `<!-- robin-jobs:start (auto-generated, do not hand-edit) -->
## Background jobs

Robin runs scheduled jobs inside the daemon (heartbeat scheduler). You CAN
call \`run_job({ name })\` to trigger one on the user's behalf, but SHOULD
only do so when the user explicitly asks. Scheduled fires happen
autonomously; don't try to drive them.

Jobs declared with \`manually_runnable: false\` (destructive maintenance,
backups, etc.) refuse \`run_job\` regardless of who calls.

### Known jobs

${renderJobsList(jobs)}
<!-- robin-jobs:end -->`;
}
```

Then in the existing `agentsMdContent({ integrations = [], jobs } = {})` (extend signature):

```js
export function agentsMdContent({ integrations = [], jobs } = {}) {
  return `# Robin
... existing content ...
${integrationsSection(integrations)}

${jobsSection(jobs)}

... rest of content ...
`;
}
```

(Locate the exact insertion point between the integrations section and the memory-tools section by reading the current file; mirror existing template-string structure.)

- [ ] **Step 4: Wire `mcp-install.js` to pass jobs**

Edit `src/cli/commands/mcp-install.js` `writeMergedAgentsMd`:

```js
async function readJobsForAgentsMd() {
  try {
    const { ensureHome, paths } = await import('../../runtime/home.js');
    const { connect, close } = await import('../../db/client.js');
    const { listAllJobs } = await import('../../jobs/db.js');
    await ensureHome();
    const p = paths();
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      return await listAllJobs(db);
    } finally {
      await close(db);
    }
  } catch {
    return undefined; // triggers "jobs surface unavailable"
  }
}

async function writeMergedAgentsMd(path) {
  await mkdir(dirname(path), { recursive: true });
  const existing = await readOrEmpty(path);
  const jobs = await readJobsForAgentsMd();
  const merged = mergeAgentsMdContent(existing, agentsMdContent({ jobs }));
  await writeFile(path, merged, 'utf8');
  console.log(`updated ${path}`);
}
```

- [ ] **Step 5: Run — pass**

```
node --test --test-force-exit tests/unit/agents-md-jobs.test.js tests/unit/agents-md-2e.test.js
```

(`agents-md-2e.test.js` must still pass — the additions are insertion-point-stable.)

- [ ] **Step 6: Lint + commit**

```
npm run lint
git add src/install/agents-md.js src/cli/commands/mcp-install.js tests/unit/agents-md-jobs.test.js
git commit -m "feat(4d): AGENTS.md jobs section + install-time DB read"
```

---

## Task 14: Integration roundtrip

End-to-end: daemon boots, discovers daily-briefing, CLI enable flips DB, manual run via MCP fires, capture event lands.

**Files:**
- Create: `tests/integration/jobs-roundtrip.test.js`

- [ ] **Step 1: Write the integration test**

```js
// tests/integration/jobs-roundtrip.test.js
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import { setEnabled, upsertFromDiscovered, getJob } from '../../src/jobs/db.js';
import { discoverJobs } from '../../src/jobs/loader.js';
import { runOneJob } from '../../src/jobs/runner.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const BUILTIN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'jobs',
  'builtin',
);

test('jobs roundtrip — discover daily-briefing → enable → run → capture event', async () => {
  const userDir = join(__h, 'jobs');
  mkdirSync(userDir, { recursive: true });

  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));

  const jobs = discoverJobs({ builtinDir: BUILTIN_DIR, userDir });
  await upsertFromDiscovered(db, jobs);

  // Ships disabled
  let row = await getJob(db, 'daily-briefing');
  assert.equal(row.enabled, false);

  // Enable
  await setEnabled(db, 'daily-briefing', true);
  row = await getJob(db, 'daily-briefing');
  assert.equal(row.enabled, true);

  // Manual run with a stub LLM
  const host = { invokeLLM: async () => ({ content: 'stubbed morning brief' }) };
  const capture = createCapture({
    db, embedder: createStubEmbedder({ dimension: 1024 }),
    source: 'job_output', embed: false, mode: 'insert-or-skip',
  });
  await runOneJob({ db, capture, host, jobs, tools: [], name: 'daily-briefing' });

  // Event captured
  const [events] = await db
    .query("SELECT * FROM events WHERE source = 'job_output'")
    .collect();
  assert.equal(events.length, 1);
  assert.match(events[0].content, /stubbed morning brief/);

  // Run state updated
  row = await getJob(db, 'daily-briefing');
  assert.equal(row.last_run_ok, true);
  assert.equal(row.in_flight, false);

  await close(db);
});

test('jobs roundtrip — user override wins over built-in', async () => {
  const userDir = join(__h, 'jobs2');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    join(userDir, 'daily-briefing.md'),
    `---
name: daily-briefing
schedule: "@hourly"
runtime: agent
enabled: true
catch_up: false
notify: capture
notify_on_failure: true
timeout_minutes: 5
manually_runnable: true
---
user override body
`,
  );

  const jobs = discoverJobs({ builtinDir: BUILTIN_DIR, userDir });
  const briefing = jobs.find((j) => j.name === 'daily-briefing');
  assert.equal(briefing.schedule, '@hourly');
  assert.equal(briefing.enabled, true);
  assert.match(briefing.body, /user override body/);
  assert.equal(briefing.source, 'user');
});
```

- [ ] **Step 2: Run — pass on first try (no new code; integration of existing pieces)**

```
node --test --test-force-exit tests/integration/jobs-roundtrip.test.js
```

- [ ] **Step 3: Run full test suite to confirm no regressions**

```
npm test
```

Expected: 850+/850+ pass. Investigate any failure.

- [ ] **Step 4: Lint + commit**

```
npm run lint
git add tests/integration/jobs-roundtrip.test.js
git commit -m "test(4d): integration roundtrip — discover, enable, run, capture, override"
```

---

## Self-review checklist (filled)

**Spec coverage:**

- §3 Job format → Task 3 (loader)
- §4 Schema → Task 1 (migration)
- §5 Heartbeat integration → Task 7 (scheduler-ext) + Task 8 (daemon wiring)
- §6 Notification dispatch → Task 5 (notify)
- §7 Cron parser → Task 2
- §8 CLI surface → Tasks 9 + 10
- §9 MCP tools (including `manually_runnable` gate) → Task 11
- §10 Built-in daily-briefing → Task 12
- §11 AGENTS.md → Task 13
- §12 Tests — every named test file appears in tasks 2-14
- §13 Migration/rollout — Task 1 (migration); no-copy approach lives in Task 3 + Task 8
- §16 Phase exit criteria → Task 14 roundtrip + per-task acceptance steps

**Placeholder scan:** No TBDs, no "TODO", no vague "handle errors appropriately" — every step has concrete code or an exact command.

**Type consistency:** `runOneJob({ db, capture, host, jobs, tools, name })` signature is used identically in Tasks 6, 8, 10 (via /internal endpoint), 11, 14. `dispatchNotify({ db, capture, name, notify, output, tools, kind })` consistent across Tasks 5 and 6. `runtime_jobs` column names match between Task 1's schema and Tasks 4/7/9/10/11/14.
