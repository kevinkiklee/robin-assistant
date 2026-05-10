import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import { dispatchNotify } from '../../src/jobs/notify.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const capture = createCapture({
    db,
    embedder: createStubEmbedder({ dimension: 1024 }),
    source: 'job_output',
    embed: false,
    mode: 'insert-or-skip',
  });
  return { db, capture };
}

const fakeDiscordTool = () => {
  const calls = [];
  return {
    tool: {
      name: 'discord_send',
      handler: async (input) => {
        calls.push(input);
        return { ok: true, message_id: 'm1' };
      },
    },
    calls,
  };
};

test('notify: capture — writes job_output event', async () => {
  const { db, capture } = await fresh();
  await dispatchNotify({
    db,
    capture,
    name: 'foo',
    notify: 'capture',
    output: 'morning summary',
    tools: [],
    kind: 'success',
  });
  const [rows] = await db.query("SELECT * FROM events WHERE source = 'job_output'").collect();
  assert.equal(rows.length, 1);
  assert.match(rows[0].external_id, /^foo:/);
  await close(db);
});

test('notify: discord_dm — calls discord_send with first allowlisted user', async () => {
  process.env.DISCORD_ALLOWED_USER_IDS = 'u1,u2';
  const { db, capture } = await fresh();
  const { tool, calls } = fakeDiscordTool();
  await dispatchNotify({
    db,
    capture,
    name: 'foo',
    notify: 'discord_dm',
    output: 'hi',
    tools: [tool],
    kind: 'success',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'send_dm');
  assert.equal(calls[0].args.user_id, 'u1');
  assert.equal(calls[0].args.content, 'hi');
  Reflect.deleteProperty(process.env, 'DISCORD_ALLOWED_USER_IDS');
  await close(db);
});

test('notify: discord_dm with empty allowlist → throws no_discord_target', async () => {
  Reflect.deleteProperty(process.env, 'DISCORD_ALLOWED_USER_IDS');
  const { db, capture } = await fresh();
  const { tool } = fakeDiscordTool();
  await assert.rejects(
    dispatchNotify({
      db,
      capture,
      name: 'foo',
      notify: 'discord_dm',
      output: 'x',
      tools: [tool],
      kind: 'success',
    }),
    /no discord notify target/,
  );
  await close(db);
});

test('notify: both — writes event AND calls discord_send', async () => {
  process.env.DISCORD_ALLOWED_USER_IDS = 'u1';
  const { db, capture } = await fresh();
  const { tool, calls } = fakeDiscordTool();
  await dispatchNotify({
    db,
    capture,
    name: 'foo',
    notify: 'both',
    output: 'msg',
    tools: [tool],
    kind: 'success',
  });
  assert.equal(calls.length, 1);
  const [rows] = await db.query("SELECT * FROM events WHERE source = 'job_output'").collect();
  assert.equal(rows.length, 1);
  Reflect.deleteProperty(process.env, 'DISCORD_ALLOWED_USER_IDS');
  await close(db);
});

test('notify: over-2000-char output truncated to 1996+…', async () => {
  process.env.DISCORD_ALLOWED_USER_IDS = 'u1';
  const { db, capture } = await fresh();
  const { tool, calls } = fakeDiscordTool();
  await dispatchNotify({
    db,
    capture,
    name: 'foo',
    notify: 'discord_dm',
    output: 'x'.repeat(5000),
    tools: [tool],
    kind: 'success',
  });
  assert.equal(calls[0].args.content.length, 2000);
  assert.match(calls[0].args.content, /…$/);
  Reflect.deleteProperty(process.env, 'DISCORD_ALLOWED_USER_IDS');
  await close(db);
});

test('notify failure path uses source=job_notification', async () => {
  const { db } = await fresh();
  const failureCapture = createCapture({
    db,
    embedder: createStubEmbedder({ dimension: 1024 }),
    source: 'job_notification',
    embed: false,
    mode: 'insert-or-skip',
  });
  await dispatchNotify({
    db,
    capture: failureCapture,
    name: 'foo',
    notify: 'capture',
    output: '[foo] failed: boom',
    tools: [],
    kind: 'failure',
  });
  const [rows] = await db.query("SELECT * FROM events WHERE source = 'job_notification'").collect();
  assert.equal(rows.length, 1);
  await close(db);
});
