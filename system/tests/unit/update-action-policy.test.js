import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { getActionTrust } from '../../cognition/jobs/action-trust.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createUpdateActionPolicyTool } from '../../io/mcp/tools/update-action-policy.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('update_action_policy — sets AUTO with set_by user', async () => {
  const db = await fresh();
  const t = createUpdateActionPolicyTool({ db });
  const r = await t.handler({ class: 'discord_send:send_dm', state: 'AUTO' });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'AUTO');
  const row = await getActionTrust(db, 'discord_send:send_dm');
  assert.equal(row.state, 'AUTO');
  assert.equal(row.set_by, 'user');
  await close(db);
});

test('update_action_policy — refuses invalid state', async () => {
  const db = await fresh();
  const t = createUpdateActionPolicyTool({ db });
  const r = await t.handler({ class: 'discord_send:send_dm', state: 'MAYBE' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_state');
  await close(db);
});

test('update_action_policy — refuses malformed class', async () => {
  const db = await fresh();
  const t = createUpdateActionPolicyTool({ db });
  const r = await t.handler({ class: 'not-valid-shape', state: 'AUTO' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_class');
  await close(db);
});
