import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { dreamProcess } from '../../cognition/dream/pipeline.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

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
  await db
    .query('UPDATE runtime:`dream.config` SET value.parallelism_enabled = true')
    .collect();
  return db;
}

test('mark idempotency: re-run sees an empty un-dreamed set, completes cleanly', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, {
    source: 'manual',
    content: 'be more concise',
    meta: { kind: 'correction' },
  });
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({
      content: JSON.stringify({
        propose: false,
        rule_text: '',
        confidence: 0,
        candidates: [],
        promote: false,
      }),
      usage: {},
    }),
  };
  await dreamProcess(db, host, e);
  const [before] = await db
    .query(surql`SELECT count() AS n FROM events WHERE dreamed_at IS NONE GROUP ALL`)
    .collect();
  assert.equal(before[0]?.n ?? 0, 0);
  // Second invocation must observe the empty un-dreamed set and complete
  // without error.
  const summary2 = await dreamProcess(db, host, e);
  assert.ok(summary2);
  assert.ok(!('error' in (summary2.knowledge ?? {})));
  const [after] = await db
    .query(surql`SELECT count() AS n FROM events WHERE dreamed_at IS NONE GROUP ALL`)
    .collect();
  assert.equal(after[0]?.n ?? 0, 0);
  await close(db);
});
