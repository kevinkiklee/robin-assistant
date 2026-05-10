import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createRecordCorrectionTool } from '../../src/mcp/tools/record-correction.js';

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

test('record_correction creates event with meta.kind=correction and triggers processor', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  const processed = [];
  const processor = async (id) => {
    processed.push(String(id));
  };
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
