// tests/unit/check-action.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setActionTrust } from '../../cognition/jobs/action-trust.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createCheckActionTool } from '../../io/mcp/tools/check-action.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('check_action — first sight returns ASK + default', async () => {
  const db = await fresh();
  const t = createCheckActionTool({ db });
  const r = await t.handler({ tool: 'discord_send', action: 'send_dm' });
  assert.equal(r.class, 'discord_send:send_dm');
  assert.equal(r.state, 'ASK');
  assert.equal(r.set_by, 'default');
  assert.equal(r.success_count, 0);
  await close(db);
});

test('check_action — reflects current state after manual flip', async () => {
  const db = await fresh();
  await setActionTrust(db, 'spotify_write:queue', 'AUTO', 'user');
  const t = createCheckActionTool({ db });
  const r = await t.handler({ tool: 'spotify_write', action: 'queue' });
  assert.equal(r.state, 'AUTO');
  assert.equal(r.set_by, 'user');
  await close(db);
});
