// tests/unit/get-comm-style.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setCommStyle } from '../../cognition/jobs/comm-style.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createGetCommStyleTool } from '../../io/mcp/tools/get-comm-style.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('get_comm_style — returns defaults with synthesized:false when unset', async () => {
  const db = await fresh();
  const t = createGetCommStyleTool({ db });
  const r = await t.handler({});
  assert.equal(r.tone, 'balanced');
  assert.equal(r.synthesized, false);
  assert.equal(r.confidence, 0);
  await close(db);
});

test('get_comm_style — returns persisted shape with synthesized:true', async () => {
  const db = await fresh();
  await setCommStyle(db, {
    tone: 'terse',
    formality: 'casual',
    emoji_ok: false,
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'bullets',
    evidence: ['events:abc'],
    confidence: 0.7,
  });
  const t = createGetCommStyleTool({ db });
  const r = await t.handler({});
  assert.equal(r.tone, 'terse');
  assert.equal(r.synthesized, true);
  assert.equal(r.confidence, 0.7);
  await close(db);
});
