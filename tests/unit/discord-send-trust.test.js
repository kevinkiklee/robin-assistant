import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import { createDiscordSendTool } from '../../src/integrations/discord/tools/discord-send.js';
import { setActionTrust } from '../../src/jobs/action-trust.js';

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

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
  writeFileSync(join(tmpHome, 'config.json'), JSON.stringify({ embedder_profile: 'mxbai-1024' }));
});
test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

async function freshSetup({ allowedUsers = '', allowedGuilds = '' } = {}) {
  const { saveSecret } = await import(`../../src/secrets/dotenv-io.js?cb=${Date.now()}`);
  if (allowedUsers) saveSecret('DISCORD_ALLOWED_USER_IDS', allowedUsers);
  if (allowedGuilds) saveSecret('DISCORD_ALLOWED_GUILD_IDS', allowedGuilds);
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'discord_send',
    embed: false,
    mode: 'insert-or-skip',
  });
  return { db, capture };
}

function mockClient({
  userSent = { id: 'msg-dm-1', channelId: 'dm-channel-1' },
  channelSent = { id: 'msg-ch-1' },
  channel = { guildId: 'g1', send: async () => channelSent, isThread: () => false },
} = {}) {
  return {
    users: {
      fetch: async (id) => ({
        id,
        send: async () => userSent,
      }),
    },
    channels: {
      fetch: async (id) => ({ ...channel, id }),
    },
  };
}

test('discord_send — first call defaults to ASK, refuses without force', async () => {
  const { db, capture } = await freshSetup({ allowedUsers: 'u1' });
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({ action: 'send_dm', args: { user_id: 'u1', content: 'hi' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'requires_permission');
  assert.equal(r.class, 'discord_send:send_dm');
  await close(db);
});

test('discord_send — ASK + force:true proceeds', async () => {
  const { db, capture } = await freshSetup({ allowedUsers: 'u1' });
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({
    action: 'send_dm',
    args: { user_id: 'u1', content: 'hi', force: true },
  });
  assert.equal(r.ok, true);
  await close(db);
});

test('discord_send — AUTO proceeds without force', async () => {
  const { db, capture } = await freshSetup({ allowedUsers: 'u1' });
  await setActionTrust(db, 'discord_send:send_dm', 'AUTO', 'user');
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({ action: 'send_dm', args: { user_id: 'u1', content: 'hi' } });
  assert.equal(r.ok, true);
  await close(db);
});

test('discord_send — NEVER refuses even with force', async () => {
  const { db, capture } = await freshSetup({ allowedUsers: 'u1' });
  await setActionTrust(db, 'discord_send:send_dm', 'NEVER', 'user');
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({
    action: 'send_dm',
    args: { user_id: 'u1', content: 'hi', force: true },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'action_not_allowed');
  await close(db);
});

test('discord_send — successful call increments success_count', async () => {
  const { db, capture } = await freshSetup({ allowedUsers: 'u1' });
  await setActionTrust(db, 'discord_send:send_dm', 'AUTO', 'user');
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  await t.handler({ action: 'send_dm', args: { user_id: 'u1', content: 'hi' } });
  const [rows] = await db
    .query("SELECT success_count FROM action_trust WHERE class = 'discord_send:send_dm'")
    .collect();
  assert.equal(rows[0].success_count, 1);
  await close(db);
});

test('discord_send — send_channel uses its own class', async () => {
  const { db, capture } = await freshSetup({ allowedGuilds: 'g1' });
  await setActionTrust(db, 'discord_send:send_channel', 'AUTO', 'user');
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({
    action: 'send_channel',
    args: { channel_id: 'c1', content: 'hi' },
  });
  assert.equal(r.ok, true);
  // send_dm class should be untouched (default = doesn't exist)
  const [rows] = await db
    .query("SELECT * FROM action_trust WHERE class = 'discord_send:send_dm'")
    .collect();
  assert.equal(rows.length, 0);
  await close(db);
});
