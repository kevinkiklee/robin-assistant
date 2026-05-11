import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../io/capture/record-event.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { dreamProcess } from '../../cognition/dream/pipeline.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

test('dreamProcess runs all steps and marks events dreamed', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  for (let i = 0; i < 3; i++) {
    await recordEvent(db, e, {
      source: 'manual',
      content: 'be more concise',
      meta: { kind: 'correction' },
    });
  }
  const host = {
    invokeLLM: async () => ({
      content: JSON.stringify({
        propose: true,
        rule_text: 'Prefer concise',
        confidence: 0.9,
        candidates: [],
        promote: false,
      }),
      usage: {},
    }),
  };
  const summary = await dreamProcess(db, host, e);
  assert.ok(summary);
  const [rows] = await db
    .query(surql`SELECT count() AS n FROM events WHERE dreamed_at IS NONE GROUP ALL`)
    .collect();
  assert.equal(rows[0]?.n ?? 0, 0);
  await close(db);
});
