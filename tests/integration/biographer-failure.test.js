import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { biographerProcess } from '../../src/capture/biographer.js';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

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
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('invokeLLM 3× failure logs to runtime:biographer.failed_event_ids', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'fails' });

  let calls = 0;
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => {
      calls++;
      throw new Error('network timeout');
    },
  };

  await assert.rejects(
    biographerProcess(db, e, host, evt.id, { retryBaseDelayMs: 0 }),
    /network timeout|failed/,
  );
  assert.equal(calls, 3, `expected 3 retries, got ${calls}`);

  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'biographer') LIMIT 1`)
    .collect();
  const failed = rows[0]?.value?.failed_event_ids ?? [];
  assert.ok(
    failed.some((id) => String(id) === String(evt.id)),
    `expected failed_event_ids to contain ${evt.id}; got ${JSON.stringify(failed)}`,
  );
  await close(db);
});

test('malformed JSON output is treated as terminal failure', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'malformed' });
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({ content: 'this is not JSON', usage: {} }),
  };
  await assert.rejects(
    biographerProcess(db, e, host, evt.id, { retryBaseDelayMs: 0 }),
    /malformed JSON|validation/i,
  );
  await close(db);
});

test('successful retry after transient failures', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'flaky' });
  let calls = 0;
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return {
        content: JSON.stringify({
          entities: [],
          edges: [],
          about: [],
          episode_continues_previous: false,
          episode_summary: null,
        }),
        usage: {},
      };
    },
  };
  const result = await biographerProcess(db, e, host, evt.id, { retryBaseDelayMs: 0 });
  assert.ok(result.processed);
  assert.equal(calls, 3);
  await close(db);
});
