import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import {
  countPendingEvents,
  listPendingEvents,
} from '../../cognition/biographer/pending-events.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

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

async function makeEvent(db, source, content) {
  await db
    .query(surql`CREATE events CONTENT ${{ source, content }}`)
    .collect();
}

test('listPendingEvents skips source=agent_internal', async () => {
  const db = await fresh();
  try {
    await makeEvent(db, 'conversation', 'real user turn');
    await makeEvent(db, 'agent_internal', 'USER: You disambiguate entity mentions...');
    await makeEvent(db, 'gmail', 'inbox message');
    const pending = await listPendingEvents(db);
    const sources = pending.map((r) => r.source).sort();
    assert.deepEqual(sources, ['conversation', 'gmail']);
  } finally {
    await close(db);
  }
});

test('countPendingEvents excludes agent_internal from the count', async () => {
  const db = await fresh();
  try {
    await makeEvent(db, 'conversation', 'real user turn');
    await makeEvent(db, 'agent_internal', 'sub-LLM scratch');
    await makeEvent(db, 'agent_internal', 'another sub-LLM call');
    const n = await countPendingEvents(db);
    assert.equal(n, 1);
  } finally {
    await close(db);
  }
});
