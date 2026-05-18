import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createRememberTool } from '../../io/mcp/tools/remember.js';
import { markTainted, __resetForTests } from '../../runtime/mcp/session-taint.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('remember writes trust=trusted on a clean session', async () => {
  __resetForTests();
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const queue = { enqueue: () => Promise.resolve() };
  const sessionId = 'session-clean-1';
  const tool = createRememberTool({ db, embedder: e, queue, getSessionId: () => sessionId });
  await tool.handler({ content: 'clean session note', source: 'manual' });
  const [rows] = await db.query(surql`SELECT trust FROM events`).collect();
  assert.equal(rows[0].trust, 'trusted');
  await close(db);
});

test('remember writes trust=untrusted when session is tainted', async () => {
  __resetForTests();
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const queue = { enqueue: () => Promise.resolve() };
  const sessionId = 'session-tainted-2';
  markTainted(sessionId, 'events:abc123');
  const tool = createRememberTool({ db, embedder: e, queue, getSessionId: () => sessionId });
  await tool.handler({ content: 'tainted session note', source: 'manual' });
  const [rows] = await db.query(surql`SELECT trust FROM events`).collect();
  assert.equal(rows[0].trust, 'untrusted');
  await close(db);
});

test('remember respects explicit source_trust override even when session is tainted', async () => {
  __resetForTests();
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const queue = { enqueue: () => Promise.resolve() };
  const sessionId = 'session-tainted-3';
  markTainted(sessionId, 'events:xyz456');
  const tool = createRememberTool({ db, embedder: e, queue, getSessionId: () => sessionId });
  await tool.handler({ content: 'explicit trusted override', source: 'manual', source_trust: 'trusted' });
  const [rows] = await db.query(surql`SELECT trust FROM events`).collect();
  assert.equal(rows[0].trust, 'trusted');
  await close(db);
});
