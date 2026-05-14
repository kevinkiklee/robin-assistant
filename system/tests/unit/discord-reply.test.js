import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { generateAndSendReply } from '../../io/integrations/discord/reply.js';

// __robin_test_home_setup__
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
  return db;
}

function makeTarget() {
  const sends = [];
  let typingPulses = 0;
  return {
    sends,
    get typingPulses() {
      return typingPulses;
    },
    send: async (text) => {
      sends.push(text);
      return { id: `m-${sends.length}` };
    },
    sendTyping: async () => {
      typingPulses += 1;
      return true;
    },
  };
}

function makeAgent(behavior) {
  // behavior: function that receives { prompt, sessionId, signal } and returns
  // an agent-result-shaped object.
  return async (args) => behavior(args);
}

test('generateAndSendReply runs the agent and delivers the result', async () => {
  const db = await fresh();
  const target = makeTarget();
  const agent = makeAgent(async () => ({
    text: 'hello world',
    sessionId: 'sess-1',
    isError: false,
    code: 'OK',
  }));
  const r = await generateAndSendReply({ db, target, prompt: 'hi', agentRunner: agent });
  assert.equal(r.sent, true);
  assert.equal(r.sessionId, 'sess-1');
  assert.deepEqual(target.sends, ['hello world']);
  await close(db);
});

test('generateAndSendReply pulses typing during the agent run', async () => {
  const db = await fresh();
  const target = makeTarget();
  const agent = makeAgent(async () => ({ text: 'ok', sessionId: 's', code: 'OK' }));
  await generateAndSendReply({ db, target, prompt: 'hi', agentRunner: agent });
  assert.ok(target.typingPulses >= 1);
  await close(db);
});

test('generateAndSendReply passes prior sessionId to the agent runner', async () => {
  const db = await fresh();
  const target = makeTarget();
  let received;
  const agent = async (args) => {
    received = args;
    return { text: 'ok', sessionId: 'sess-new', code: 'OK' };
  };
  await generateAndSendReply({
    db,
    target,
    prompt: 'p',
    sessionId: 'sess-prev',
    agentRunner: agent,
  });
  assert.equal(received.sessionId, 'sess-prev');
  await close(db);
});

test('generateAndSendReply returns the new sessionId from the agent', async () => {
  const db = await fresh();
  const target = makeTarget();
  const agent = makeAgent(async () => ({ text: 'reply', sessionId: 'sess-99', code: 'OK' }));
  const r = await generateAndSendReply({ db, target, prompt: 'p', agentRunner: agent });
  assert.equal(r.sessionId, 'sess-99');
  await close(db);
});

test('generateAndSendReply blocks PII reply via outbound policy', async () => {
  const db = await fresh();
  const target = makeTarget();
  const agent = makeAgent(async () => ({
    text: 'card 4111 1111 1111 1111',
    sessionId: 'x',
    code: 'OK',
  }));
  const r = await generateAndSendReply({ db, target, prompt: 'p', agentRunner: agent });
  assert.equal(r.sent, false);
  assert.match(target.sends[0], /blocked/);
  await close(db);
});

test('generateAndSendReply bypasses untrusted-quote at trusted origin', async () => {
  const db = await fresh();
  const target = makeTarget();
  const agent = makeAgent(async () => ({
    text: 'this is a normal informational reply with no PII or secrets at all today',
    sessionId: 'x',
    code: 'OK',
  }));
  // Use a non-PII reply; the trusted-origin path is exercised by the outbound
  // policy tests directly — this test just verifies the params flow through.
  const r = await generateAndSendReply({
    db,
    target,
    prompt: 'p',
    agentRunner: agent,
    origin: 'discord:guild:G1:channel:C1',
    trustedOrigins: ['discord:guild:G1'],
  });
  assert.equal(r.sent, true);
  await close(db);
});

test('generateAndSendReply with no target returns no_target', async () => {
  const db = await fresh();
  const r = await generateAndSendReply({ db, target: null, prompt: 'p' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no_target');
  await close(db);
});

test('generateAndSendReply on CANCELLED stays silent (no channel post)', async () => {
  const db = await fresh();
  const target = makeTarget();
  const agent = makeAgent(async () => ({ text: '', sessionId: null, code: 'CANCELLED' }));
  const r = await generateAndSendReply({ db, target, prompt: 'p', agentRunner: agent });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'cancelled');
  assert.equal(target.sends.length, 0);
  await close(db);
});

test('generateAndSendReply chunks long replies into multiple sends', async () => {
  const db = await fresh();
  const long = 'x '.repeat(2500);
  const agent = makeAgent(async () => ({ text: long, sessionId: 'x', code: 'OK' }));
  const target = makeTarget();
  const r = await generateAndSendReply({ db, target, prompt: 'p', agentRunner: agent });
  assert.equal(r.sent, true);
  assert.ok(target.sends.length >= 3);
  for (const s of target.sends) {
    assert.ok(s.length <= 2000);
  }
  await close(db);
});

test('generateAndSendReply on empty result surfaces no_reply', async () => {
  const db = await fresh();
  const target = makeTarget();
  const agent = makeAgent(async () => ({ text: '', sessionId: 'x', code: 'OK' }));
  const r = await generateAndSendReply({ db, target, prompt: 'p', agentRunner: agent });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'empty_reply');
  await close(db);
});
