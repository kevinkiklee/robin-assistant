// Snapshot test for health(): validates the realm-grouped shape produced
// by reshapeForMCP wiring. Stub probes; no DB.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHealthTool } from '../../io/mcp/tools/health.js';

function stubDb({ open = true, queryThrows = false } = {}) {
  const empty = { collect: async () => [[]] };
  return {
    isOpen: () => open,
    query: () => {
      if (queryThrows) {
        return {
          collect: async () => {
            throw new Error('db down');
          },
        };
      }
      return empty;
    },
  };
}

function makeArgs(overrides = {}) {
  return {
    version: '6.0.0-test',
    startedAt: new Date(Date.now() - 5000),
    db: stubDb(),
    embedder: { isLoaded: () => true },
    biographerQueue: { lastRunAt: null },
    sessions: { count: 0 },
    ...overrides,
  };
}

test('health returns realm-grouped shape from reshapeForMCP', async () => {
  const tool = createHealthTool(makeArgs());
  const result = await tool.handler({});
  // Realm-grouped wiring
  assert.ok(result.ts, 'ts present');
  assert.match(result.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(result.summary, 'summary present');
  assert.equal(typeof result.summary.ok, 'number');
  assert.equal(typeof result.summary.warn, 'number');
  assert.equal(typeof result.summary.fail, 'number');
  assert.ok(result.realms, 'realms present');
  // db.open should land in the 'db' realm.
  assert.ok(result.realms.db, 'db realm present');
  assert.equal(result.realms.db.status, 'ok');
  assert.equal(result.realms.db.checks[0].name, 'db.open');
  // embedder.loaded + biographer.queue land in 'runtime'.
  assert.ok(result.realms.runtime, 'runtime realm present');
  const runtimeNames = result.realms.runtime.checks.map((c) => c.name);
  assert.ok(runtimeNames.includes('embedder.loaded'));
  assert.ok(runtimeNames.includes('biographer.queue'));
});

test('health preserves flat backward-compat fields alongside reshape', async () => {
  const tool = createHealthTool(makeArgs());
  const result = await tool.handler({});
  // Flat fields the daemon CLI surface and earlier consumers rely on.
  assert.equal(result.version, '6.0.0-test');
  assert.equal(result.status, 'ok');
  assert.equal(result.db_open, true);
  assert.equal(result.embedder_loaded, true);
  assert.equal(result.active_sessions, 0);
  assert.equal(typeof result.uptime_seconds, 'number');
});

test('health degrades and embedder.loaded=false flips realm to warn', async () => {
  const tool = createHealthTool(
    makeArgs({
      embedder: { isLoaded: () => false },
    }),
  );
  const result = await tool.handler({});
  // embedder.loaded=false is a warn (not fail) — realm rolls up to warn.
  assert.equal(result.realms.runtime.status, 'warn');
  const e = result.realms.runtime.checks.find((c) => c.name === 'embedder.loaded');
  assert.equal(e.status, 'warn');
});

test('health fails db.open when db is closed', async () => {
  const tool = createHealthTool(
    makeArgs({
      db: stubDb({ open: false, queryThrows: true }),
    }),
  );
  const result = await tool.handler({});
  assert.equal(result.realms.db.status, 'fail');
  assert.equal(result.realms.db.checks[0].status, 'fail');
  // Top-level rollup still 'degraded' for backward compat.
  assert.equal(result.status, 'degraded');
});
