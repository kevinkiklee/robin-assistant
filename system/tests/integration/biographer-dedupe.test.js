import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { biographerProcess } from '../../cognition/biographer/pipeline.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

test('two parallel biographer invocations on same event do not double-extract', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'Alice was here.' });
  let calls = 0;
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => {
      calls++;
      return {
        content: JSON.stringify({
          entities: [{ name: 'Alice', type: 'person' }],
          edges: [],
          about: [],
          episode_continues_previous: false,
          episode_summary: null,
        }),
        usage: {},
      };
    },
  };
  await Promise.all([
    biographerProcess(db, e, host, evt.id),
    biographerProcess(db, e, host, evt.id),
  ]);
  // The race-prone path: both pass the biographed_at check before either commits.
  // Acceptable: at least one LLM call (must be ≥ 1), but never more than 1 entity row created.
  assert.ok(calls >= 1, `expected at least 1 LLM call, got ${calls}`);
  const [rows] = await db.query('SELECT count() AS n FROM entities GROUP ALL').collect();
  assert.equal(rows[0].n, 1, `expected 1 entity, got ${rows[0].n} (LLM was called ${calls} times)`);
  await close(db);
});
