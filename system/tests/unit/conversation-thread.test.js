import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  appendToThread,
  computeThreadId,
  pruneStaleThreads,
  readThreadContext,
  resolveThreadId,
} from '../../cognition/sessions/conversation-thread.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('computeThreadId is deterministic and safe', () => {
  const id1 = computeThreadId({
    channel: 'imessage',
    peer_id: '+15551234567',
    bucketStartMs: 1000,
  });
  const id2 = computeThreadId({
    channel: 'imessage',
    peer_id: '+15551234567',
    bucketStartMs: 1000,
  });
  assert.equal(id1, id2);
  // Special chars in peer_id are sanitized.
  const id3 = computeThreadId({
    channel: 'imessage',
    peer_id: 'user@example.com',
    bucketStartMs: 1000,
  });
  assert.match(id3, /imessage__user_example_com__1000/);
});

test('resolveThreadId returns new bucket when no thread exists', async () => {
  const db = await fresh();
  const r = await resolveThreadId(db, { channel: 'imessage', peer_id: 'dad@x.com' });
  assert.equal(r.resumed, false);
  assert.ok(r.thread_id);
  await close(db);
});

test('resolveThreadId resumes existing thread within window', async () => {
  const db = await fresh();
  const first = await resolveThreadId(db, { channel: 'imessage', peer_id: 'dad@x.com' });
  await appendToThread(db, {
    thread_id: first.thread_id,
    channel: 'imessage',
    peer_id: 'dad@x.com',
    role: 'user',
    content: 'hi',
  });
  const second = await resolveThreadId(db, { channel: 'imessage', peer_id: 'dad@x.com' });
  assert.equal(second.resumed, true);
  assert.equal(second.thread_id, first.thread_id);
  await close(db);
});

test('resolveThreadId starts new thread after window expires', async () => {
  const db = await fresh();
  const first = await resolveThreadId(db, { channel: 'imessage', peer_id: 'dad@x.com' });
  await appendToThread(db, {
    thread_id: first.thread_id,
    channel: 'imessage',
    peer_id: 'dad@x.com',
    role: 'user',
    content: 'hi',
  });
  // Simulate 31 min later — past 30-min window.
  const future = Date.now() + 31 * 60_000;
  const next = await resolveThreadId(
    db,
    { channel: 'imessage', peer_id: 'dad@x.com' },
    { now: () => future },
  );
  assert.equal(next.resumed, false);
  assert.notEqual(next.thread_id, first.thread_id);
  await close(db);
});

test('appendToThread caps history at maxMessages via tail-prune', async () => {
  const db = await fresh();
  const { thread_id } = await resolveThreadId(db, { channel: 'terminal', peer_id: 'terminal' });
  for (let i = 0; i < 20; i += 1) {
    await appendToThread(
      db,
      { thread_id, channel: 'terminal', peer_id: 'terminal', role: 'user', content: `msg ${i}` },
      { maxMessages: 5, maxTokens: 999_999 },
    );
  }
  const ctx = await readThreadContext(db, thread_id);
  assert.equal(ctx.messages.length, 5);
  // Most-recent kept.
  assert.equal(ctx.messages.at(-1).content, 'msg 19');
  await close(db);
});

test('appendToThread caps by token budget too', async () => {
  const db = await fresh();
  const { thread_id } = await resolveThreadId(db, { channel: 'terminal', peer_id: 'terminal' });
  const big = 'x'.repeat(1000); // ~250 tokens each
  for (let i = 0; i < 20; i += 1) {
    await appendToThread(
      db,
      { thread_id, channel: 'terminal', peer_id: 'terminal', role: 'user', content: big },
      { maxMessages: 999, maxTokens: 500 },
    );
  }
  const ctx = await readThreadContext(db, thread_id);
  assert.ok(ctx.token_count <= 500, `token_count=${ctx.token_count}`);
  await close(db);
});

test('appendToThread distinguishes channels for same peer', async () => {
  const db = await fresh();
  const imThread = await resolveThreadId(db, { channel: 'imessage', peer_id: 'kevin' });
  const dThread = await resolveThreadId(db, { channel: 'discord', peer_id: 'kevin' });
  assert.notEqual(imThread.thread_id, dThread.thread_id);
  await close(db);
});

test('readThreadContext returns empty for unknown thread', async () => {
  const db = await fresh();
  const ctx = await readThreadContext(db, 'nope');
  assert.deepEqual(ctx, { messages: [], token_count: 0 });
  await close(db);
});

test('pruneStaleThreads deletes threads past max age', async () => {
  const db = await fresh();
  const { thread_id } = await resolveThreadId(db, { channel: 'discord', peer_id: 'kevin' });
  await appendToThread(db, {
    thread_id,
    channel: 'discord',
    peer_id: 'kevin',
    role: 'user',
    content: 'old',
  });
  // Force last_msg_at into the past.
  await db
    .query(
      `UPDATE conversation_threads SET last_msg_at = time::now() - 25h WHERE thread_id = '${thread_id}'`,
    )
    .collect();
  const r = await pruneStaleThreads(db, { maxAgeMs: 24 * 60 * 60_000 });
  assert.equal(r.deleted, 1);
  const ctx = await readThreadContext(db, thread_id);
  assert.equal(ctx.messages.length, 0);
  await close(db);
});
