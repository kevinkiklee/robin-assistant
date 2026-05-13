import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as __robinTmpdir, tmpdir } from 'node:os';
import { join as __robinJoin, join, resolve } from 'node:path';
import { test } from 'node:test';
import { setActionTrust } from '../../cognition/jobs/action-trust.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';
import { createDiscordSendTool } from '../../io/integrations/discord/tools/discord-send.js';

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
  mkdirSync(join(tmpHome, 'config'), { recursive: true });
  writeFileSync(join(tmpHome, 'config', 'config.json'), JSON.stringify({ embedder_profile: 'mxbai-1024' }));
});
test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

async function freshSetup({ allowedUsers = '', allowedGuilds = '' } = {}) {
  // Write the discord allowlist into the per-test .env so getSecret picks it up.
  const { saveSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  if (allowedUsers) saveSecret('DISCORD_ALLOWED_USER_IDS', allowedUsers);
  if (allowedGuilds) saveSecret('DISCORD_ALLOWED_GUILD_IDS', allowedGuilds);
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  // Seed AUTO for both actions so existing tests bypass the trust gate.
  await setActionTrust(db, 'discord_send:send_dm', 'AUTO', 'user');
  await setActionTrust(db, 'discord_send:send_channel', 'AUTO', 'user');
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
  fetchUserError = null,
  fetchChannelError = null,
  channelOverride = null,
} = {}) {
  return {
    users: {
      fetch: async (id) => {
        if (fetchUserError) throw fetchUserError;
        return {
          id,
          send: async () => userSent,
        };
      },
    },
    channels: {
      fetch: async (id) => {
        if (fetchChannelError) throw fetchChannelError;
        return channelOverride ?? { ...channel, id };
      },
    },
  };
}

test('schema + name', async () => {
  const { db, capture } = await freshSetup();
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => null });
  assert.equal(t.name, 'discord_send');
  assert.deepEqual(t.inputSchema.required, ['action', 'args']);
  assert.deepEqual(t.inputSchema.properties.action.enum, ['send_dm', 'send_channel']);
  await close(db);
});

test('unknown action', async () => {
  const { db, capture } = await freshSetup();
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({ action: 'edit', args: { content: 'hi' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_action');
  await close(db);
});

test('missing content', async () => {
  const { db, capture } = await freshSetup();
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({ action: 'send_dm', args: { user_id: 'u1' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_arg');
  assert.equal(r.arg, 'content');
  await close(db);
});

test('content over 2000 chars → content_too_long', async () => {
  const { db, capture } = await freshSetup();
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({
    action: 'send_dm',
    args: { user_id: 'u1', content: 'x'.repeat(2001) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'content_too_long');
  assert.equal(r.max, 2000);
  assert.equal(r.given, 2001);
  await close(db);
});

test('gateway not running → discord_not_running', async () => {
  const { db, capture } = await freshSetup();
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => null });
  const r = await t.handler({ action: 'send_dm', args: { user_id: 'u1', content: 'hi' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'discord_not_running');
  await close(db);
});

test('send_dm missing user_id', async () => {
  const { db, capture } = await freshSetup();
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({ action: 'send_dm', args: { content: 'hi' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_arg');
  assert.equal(r.arg, 'user_id');
  await close(db);
});

test('send_dm not in user allowlist → not_allowed', async () => {
  const { db, capture } = await freshSetup({ allowedUsers: 'u-allowed' });
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({
    action: 'send_dm',
    args: { user_id: 'u-other', content: 'hi' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_allowed');
  await close(db);
});

test('send_dm happy path captures event', async () => {
  const { db, capture } = await freshSetup({ allowedUsers: 'u1,u2' });
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({
    action: 'send_dm',
    args: { user_id: 'u1', content: 'hello there' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.message_id, 'msg-dm-1');

  // Verify capture event written
  const [rows] = await db.query("SELECT * FROM events WHERE source = 'discord_send'").collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.external_id, 'msg-dm-1');
  assert.equal(rows[0].meta.action, 'send_dm');
  assert.equal(rows[0].meta.target.user_id, 'u1');
  assert.equal(rows[0].meta.length, 'hello there'.length);
  await close(db);
});

test('send_channel missing channel_id', async () => {
  const { db, capture } = await freshSetup({ allowedGuilds: 'g1' });
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({ action: 'send_channel', args: { content: 'hi' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_arg');
  assert.equal(r.arg, 'channel_id');
  await close(db);
});

test('send_channel guild not allowlisted → not_allowed', async () => {
  const { db, capture } = await freshSetup({ allowedGuilds: 'g-other' });
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({
    action: 'send_channel',
    args: { channel_id: 'c1', content: 'hi' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_allowed');
  await close(db);
});

test('send_channel happy path captures event with guild_id', async () => {
  const { db, capture } = await freshSetup({ allowedGuilds: 'g1' });
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  const r = await t.handler({
    action: 'send_channel',
    args: { channel_id: 'c1', content: 'hi from agent' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.message_id, 'msg-ch-1');
  assert.equal(r.channel_id, 'c1');

  const [rows] = await db.query("SELECT * FROM events WHERE source = 'discord_send'").collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.target.channel_id, 'c1');
  assert.equal(rows[0].meta.target.guild_id, 'g1');
  await close(db);
});

test('send_channel into thread channel — parent guild allowlisted', async () => {
  const { db, capture } = await freshSetup({ allowedGuilds: 'g1' });
  const threadChannel = {
    guildId: 'g1',
    isThread: () => true,
    send: async () => ({ id: 'msg-thread-1' }),
  };
  const t = createDiscordSendTool({
    db,
    capture,
    getGatewayClient: () => mockClient({ channelOverride: threadChannel }),
  });
  const r = await t.handler({
    action: 'send_channel',
    args: { channel_id: 'thr-1', content: 'in-thread' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.message_id, 'msg-thread-1');
  await close(db);
});

test('send_channel channel not found → channel_not_found', async () => {
  const { db, capture } = await freshSetup({ allowedGuilds: 'g1' });
  const err = new Error('Unknown Channel');
  err.code = 10003;
  err.status = 404;
  const t = createDiscordSendTool({
    db,
    capture,
    getGatewayClient: () => mockClient({ fetchChannelError: err }),
  });
  const r = await t.handler({
    action: 'send_channel',
    args: { channel_id: 'nope', content: 'hi' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'channel_not_found');
  await close(db);
});

test('send_dm to user with closed DMs → dms_closed', async () => {
  const { db, capture } = await freshSetup({ allowedUsers: 'u1' });
  const err = new Error('Cannot send messages to this user');
  err.code = 50007;
  const t = createDiscordSendTool({
    db,
    capture,
    getGatewayClient: () => mockClient({ fetchUserError: err }),
  });
  const r = await t.handler({
    action: 'send_dm',
    args: { user_id: 'u1', content: 'hi' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'dms_closed');
  await close(db);
});

test('outbound policy refusal → outbound_blocked, refusal logged', async () => {
  const { db, capture } = await freshSetup({ allowedUsers: 'u1' });
  const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
  // SSN-shape pattern triggers PII guard.
  const r = await t.handler({
    action: 'send_dm',
    args: { user_id: 'u1', content: 'my ssn is 123-45-6789' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'outbound_blocked');
  assert.match(r.blocked_by, /^pii:/);
  // Refusal row written
  const [rows] = await db
    .query("SELECT * FROM refusals WHERE meta.destination = 'discord_send'")
    .collect();
  assert.equal(rows.length, 1);
  await close(db);
});

test('rate-limit refusal short-circuits', async () => {
  const { db, capture } = await freshSetup({ allowedUsers: 'u1' });
  process.env.DISCORD_SEND_RATE_LIMIT = '1';
  try {
    const t = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });
    const r1 = await t.handler({
      action: 'send_dm',
      args: { user_id: 'u1', content: 'first' },
    });
    assert.equal(r1.ok, true);
    const r2 = await t.handler({
      action: 'send_dm',
      args: { user_id: 'u1', content: 'second' },
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'rate_limited');
  } finally {
    Reflect.deleteProperty(process.env, 'DISCORD_SEND_RATE_LIMIT');
    await close(db);
  }
});
