// tests/integration/actions-roundtrip.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';
import { createDiscordSendTool } from '../../io/integrations/discord/tools/discord-send.js';
import { demoteOnCorrection, getActionTrust, setActionTrust } from '../../cognition/jobs/action-trust.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { saveSecret } from '../../config/secrets.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const mockClient = () => ({
  users: {
    fetch: async (id) => ({ id, send: async () => ({ id: 'msg-1', channelId: 'dm-1' }) }),
  },
  channels: { fetch: async () => null },
});

test('actions roundtrip: ASK by default → user promotes → AUTO → correction demotes', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const embedder = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder,
    source: 'discord_send',
    embed: false,
    mode: 'insert-or-skip',
  });
  saveSecret('DISCORD_ALLOWED_USER_IDS', 'u1');

  const tool = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });

  // 1. First call: defaults to ASK → refuses
  let r = await tool.handler({ action: 'send_dm', args: { user_id: 'u1', content: 'hello' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'requires_permission');
  assert.equal(r.class, 'discord_send:send_dm');

  // 2. User authorizes this turn only: force:true succeeds
  r = await tool.handler({
    action: 'send_dm',
    args: { user_id: 'u1', content: 'hello', force: true },
  });
  assert.equal(r.ok, true);

  // 3. User gives standing permission via setActionTrust
  await setActionTrust(db, 'discord_send:send_dm', 'AUTO', 'user');

  // 4. Next call without force succeeds
  r = await tool.handler({ action: 'send_dm', args: { user_id: 'u1', content: 'second send' } });
  assert.equal(r.ok, true);

  // 5. User corrects — demote
  const d = await demoteOnCorrection(db, 'discord_send:send_dm');
  assert.equal(d.demoted, true);
  assert.equal(d.from, 'AUTO');

  // 6. Next call without force refuses again
  r = await tool.handler({ action: 'send_dm', args: { user_id: 'u1', content: 'third send' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'requires_permission');

  // 7. Trust row reflects all of this
  const row = await getActionTrust(db, 'discord_send:send_dm');
  assert.equal(row.state, 'ASK');
  assert.equal(row.set_by, 'correction');
  assert.equal(row.success_count, 2, 'two prior successes recorded');
  assert.equal(row.correction_count, 1);

  await close(db);
});
