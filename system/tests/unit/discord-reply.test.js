import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { generateAndSendReply } from '../../io/integrations/discord/reply.js';
import { makeMessage } from '../fixtures/discord-events.js';

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
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('generateAndSendReply sends LLM-drafted clean reply', async () => {
  const db = await fresh();
  const host = { invokeLLM: async () => ({ content: 'hello world', usage: {} }) };
  const replies = [];
  const message = {
    ...makeMessage({}),
    reply: async (t) => {
      replies.push(t);
    },
  };
  const r = await generateAndSendReply({ db, host, message, prompt: 'p' });
  assert.equal(r.sent, true);
  assert.equal(replies[0], 'hello world');
  await close(db);
});

test('generateAndSendReply blocks PII reply', async () => {
  const db = await fresh();
  const host = { invokeLLM: async () => ({ content: 'card 4111 1111 1111 1111', usage: {} }) };
  const replies = [];
  const message = {
    ...makeMessage({}),
    reply: async (t) => {
      replies.push(t);
    },
  };
  const r = await generateAndSendReply({ db, host, message, prompt: 'p' });
  assert.equal(r.sent, false);
  assert.match(replies[0], /blocked/);
  await close(db);
});

test('generateAndSendReply with no host falls back', async () => {
  const db = await fresh();
  const replies = [];
  const message = {
    ...makeMessage({}),
    reply: async (t) => {
      replies.push(t);
    },
  };
  const r = await generateAndSendReply({ db, host: null, message, prompt: 'p' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no_host');
  assert.match(replies[0], /unavailable/);
  await close(db);
});
