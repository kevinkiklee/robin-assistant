import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';
import {
  buildBotReplyEvent,
  buildMessages,
  fetchHistory,
  insertBoundary,
} from '../../io/integrations/discord/history.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function freshDb() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function makeCapture(db) {
  return createCapture({
    db,
    embedder: createStubEmbedder({ dimension: 1024 }),
    source: 'discord',
    embed: false,
    mode: 'insert-or-skip',
  });
}

function userEvent({ channelId, content, kind = 'thread', id, ts }) {
  return {
    source: 'discord',
    content,
    ts: ts ?? new Date(),
    external_id: id,
    trust: 'untrusted',
    meta: { kind, channel_id: channelId, author_id: 'u1' },
  };
}

test('fetchHistory returns empty for unknown channel', async () => {
  const db = await freshDb();
  const result = await fetchHistory(db, 'no-such-channel');
  assert.deepEqual(result, []);
  await close(db);
});

test('fetchHistory returns chronological user + bot turns scoped to channelId', async () => {
  const db = await freshDb();
  const capture = makeCapture(db);
  const t0 = Date.now();
  await capture([
    userEvent({ channelId: 'A', id: 'm1', content: 'hi', ts: new Date(t0) }),
    buildBotReplyEvent({ channelId: 'A', replyText: 'hello', botUserId: 'b', messageId: 'm1' }),
    userEvent({ channelId: 'A', id: 'm2', content: 'how are you', ts: new Date(t0 + 10) }),
    // A separate channel — should NOT appear in history for A.
    userEvent({ channelId: 'B', id: 'm3', content: 'leak?', ts: new Date(t0 + 20) }),
  ]);

  const history = await fetchHistory(db, 'A');
  assert.deepEqual(
    history.map((t) => [t.role, t.content]),
    [
      ['user', 'hi'],
      ['assistant', 'hello'],
      ['user', 'how are you'],
    ],
  );
  await close(db);
});

test('fetchHistory stops at the most recent /new boundary', async () => {
  const db = await freshDb();
  const capture = makeCapture(db);
  // Build a strictly-increasing timeline anchored to "now" so the boundary
  // (which insertBoundary stamps with new Date()) lands between the
  // pre-boundary and post-boundary turns.
  const t0 = Date.now();
  await capture([
    userEvent({ channelId: 'A', id: 'm1', content: 'ancient', ts: new Date(t0 - 5000) }),
    userEvent({ channelId: 'A', id: 'm2', content: 'older', ts: new Date(t0 - 4000) }),
  ]);
  await insertBoundary(capture, 'A', 'u1'); // ts ≈ t0
  const reply = buildBotReplyEvent({
    channelId: 'A',
    replyText: 'fresh',
    botUserId: 'b',
    messageId: 'm3',
  });
  await capture([
    userEvent({ channelId: 'A', id: 'm3', content: 'new convo', ts: new Date(t0 + 1000) }),
    { ...reply, ts: new Date(t0 + 2000) },
  ]);

  const history = await fetchHistory(db, 'A');
  assert.deepEqual(
    history.map((t) => t.content),
    ['new convo', 'fresh'],
  );
  await close(db);
});

test('fetchHistory caps at maxTurns (most recent)', async () => {
  const db = await freshDb();
  const capture = makeCapture(db);
  const events = [];
  for (let i = 0; i < 15; i++) {
    events.push(
      userEvent({ channelId: 'A', id: `m${i}`, content: `turn ${i}`, ts: new Date(1000 + i * 10) }),
    );
  }
  await capture(events);
  const history = await fetchHistory(db, 'A', { maxTurns: 5 });
  assert.equal(history.length, 5);
  assert.equal(history[0].content, 'turn 10'); // dropped 0..9, kept 10..14
  assert.equal(history[4].content, 'turn 14');
  await close(db);
});

test('fetchHistory caps total chars by dropping oldest', async () => {
  const db = await freshDb();
  const capture = makeCapture(db);
  const big = 'x'.repeat(3000);
  const events = [];
  for (let i = 0; i < 5; i++) {
    events.push(
      userEvent({
        channelId: 'A',
        id: `m${i}`,
        content: `${i}:${big}`,
        ts: new Date(1000 + i * 10),
      }),
    );
  }
  await capture(events);
  // maxChars=5000 ⇒ should keep at most 1 turn (each is ~3000 chars).
  const history = await fetchHistory(db, 'A', { maxChars: 5000 });
  assert.equal(history.length, 1, `expected 1 turn, got ${history.length}`);
  assert.equal(history[0].content.startsWith('4:'), true); // newest kept
  await close(db);
});

test('fetchHistory ignores slash-command events', async () => {
  const db = await freshDb();
  const capture = makeCapture(db);
  await capture([
    userEvent({ channelId: 'A', id: 'm1', content: 'hi', ts: new Date(1000) }),
    {
      source: 'discord',
      content: 'help',
      ts: new Date(1500),
      external_id: 'slash1',
      trust: 'untrusted',
      meta: { kind: 'slash', channel_id: 'A', author_id: 'u1' },
    },
    buildBotReplyEvent({ channelId: 'A', replyText: 'hey', botUserId: 'b', messageId: 'm1' }),
  ]);
  const history = await fetchHistory(db, 'A');
  assert.deepEqual(
    history.map((t) => t.content),
    ['hi', 'hey'],
  );
  await close(db);
});

test('buildMessages dedupes when history already ends with the current prompt', () => {
  const history = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' },
  ];
  const messages = buildMessages(history, 'second');
  assert.deepEqual(messages, history);
});

test('buildMessages appends current prompt when history ends with assistant', () => {
  const history = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
  ];
  const messages = buildMessages(history, 'second');
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[2], { role: 'user', content: 'second' });
});

test('buildMessages handles empty history', () => {
  const messages = buildMessages([], 'hello');
  assert.deepEqual(messages, [{ role: 'user', content: 'hello' }]);
});
