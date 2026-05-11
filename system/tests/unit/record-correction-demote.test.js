// tests/unit/record-correction-demote.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { getActionTrust, setActionTrust } from '../../cognition/jobs/action-trust.js';
import { createRecordCorrectionTool } from '../../io/mcp/tools/record-correction.js';

import { writeConfig as __wc } from '../../config/paths.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const embedder = createStubEmbedder({ dimension: 1024 });
  return { db, embedder };
}

test('record_correction with tool+action demotes AUTO → ASK', async () => {
  const { db, embedder } = await fresh();
  await setActionTrust(db, 'discord_send:send_dm', 'AUTO', 'user');
  const t = createRecordCorrectionTool({ db, embedder, processor: async () => {} });
  const r = await t.handler({
    content: 'that DM went to the wrong person',
    tool: 'discord_send',
    action: 'send_dm',
  });
  assert.equal(r.demoted_class, 'discord_send:send_dm');
  const row = await getActionTrust(db, 'discord_send:send_dm');
  assert.equal(row.state, 'ASK');
  assert.equal(row.set_by, 'correction');
  await close(db);
});

test('record_correction without tool+action does not touch action_trust', async () => {
  const { db, embedder } = await fresh();
  const t = createRecordCorrectionTool({ db, embedder, processor: async () => {} });
  const r = await t.handler({ content: 'general correction, not an action' });
  assert.ok(!('demoted_class' in r) || r.demoted_class == null);
  await close(db);
});
