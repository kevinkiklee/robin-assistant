import { strict as assert } from 'node:assert';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import test from 'node:test';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { setIntegrationEnabled } from '../../data/runtime/integrations-state.js';
import { buildTools } from '../../runtime/daemon/tools.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function freshDb() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function stubCtx(db, manifests) {
  return {
    db,
    version: '0.0.0-test',
    startedAt: new Date(),
    embedder: { wrap: {}, idle: { get: async () => ({}) } },
    queue: { size: () => 0, enqueue: async () => {} },
    sessions: { active: null },
    detector: {},
    capture: { forJobs: () => {} },
    host: {},
    registry: new Map(),
    gatewayClients: new Map(),
    jobs: { cache: { current: [] }, refresh: async () => {} },
    manifests,
  };
}

test('disabled integration registers no tools (default disabled)', async () => {
  const db = await freshDb();
  try {
    let called = false;
    const manifest = {
      name: 'fakefoo',
      cadence_ms: 60_000,
      kind: 'sync',
      tools: [
        () => {
          called = true;
          return { name: 'fakefoo_tool', handler: async () => ({}) };
        },
      ],
      _source: 'user-data',
    };
    const tools = await buildTools(stubCtx(db, [manifest]));
    assert.equal(called, false, 'tool factory should NOT have been invoked');
    assert.ok(!tools.some((t) => t.name === 'fakefoo_tool'));
  } finally {
    await close(db);
  }
});

test('enabled integration registers tools', async () => {
  const db = await freshDb();
  try {
    await setIntegrationEnabled(db, 'fakebar', { enabled: true, source: 'user-data' });
    let called = false;
    const manifest = {
      name: 'fakebar',
      cadence_ms: 60_000,
      kind: 'sync',
      tools: [
        () => {
          called = true;
          return { name: 'fakebar_tool', handler: async () => ({}) };
        },
      ],
      _source: 'user-data',
    };
    const tools = await buildTools(stubCtx(db, [manifest]));
    assert.equal(called, true, 'tool factory should have been invoked once enabled');
    assert.ok(tools.some((t) => t.name === 'fakebar_tool'));
  } finally {
    await close(db);
  }
});
