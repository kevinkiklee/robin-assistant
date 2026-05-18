import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createTriggerEngine } from '../../cognition/triggers/engine.js';
import { createTriggerTick } from '../../cognition/triggers/loop.js';
import { readTriggerCursor } from '../../cognition/triggers/persistence.js';
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

function quietLogger() {
  return { warn: () => {}, error: () => {} };
}

test('createTriggerTick validates required deps', () => {
  assert.throws(() => createTriggerTick({}), /db is required/);
  assert.throws(() => createTriggerTick({ db: {} }), /engine is required/);
  assert.throws(() => createTriggerTick({ db: {}, engine: {} }), /dispatchTool/);
});

test('tick is no-op when no triggers registered', async () => {
  const db = await fresh();
  const engine = createTriggerEngine({ sleep: async () => {}, logger: quietLogger() });
  const tick = createTriggerTick({ db, engine, dispatchTool: async () => {} });
  await db.query('CREATE events SET source = "whoop", content = "x"').collect();
  const r = await tick();
  assert.deepEqual(r, { processed: 0, fired: 0 });
  // Cursor should NOT have advanced — no triggers means no work.
  const cur = await readTriggerCursor(db);
  assert.equal(cur.last_event_ts, null);
  await close(db);
});

test('tick processes all events when cursor unset', async () => {
  const db = await fresh();
  const engine = createTriggerEngine({ sleep: async () => {}, logger: quietLogger() });
  const dispatched = [];
  engine.register({
    name: 'whoop-watcher',
    on: 'whoop',
    do: [{ tool: 'macos_notify', args: { title: 'whoop' } }],
  });
  await db.query('CREATE events SET source = "whoop", content = "1"').collect();
  await new Promise((r) => setTimeout(r, 2));
  await db.query('CREATE events SET source = "gmail", content = "2"').collect();
  await new Promise((r) => setTimeout(r, 2));
  await db.query('CREATE events SET source = "whoop", content = "3"').collect();

  const tick = createTriggerTick({
    db,
    engine,
    dispatchTool: async (tool, args) => dispatched.push({ tool, args }),
  });
  const r = await tick();
  assert.equal(r.processed, 3);
  assert.equal(r.fired, 2); // Two whoop events matched, gmail did not.
  assert.equal(dispatched.length, 2);
  await close(db);
});

test('tick advances cursor to last processed event', async () => {
  const db = await fresh();
  const engine = createTriggerEngine({ sleep: async () => {}, logger: quietLogger() });
  engine.register({ name: 't', on: 'whoop', do: [{ tool: 'x' }] });
  await db.query('CREATE events SET source = "whoop", content = "a"').collect();
  await new Promise((r) => setTimeout(r, 5));
  await db.query('CREATE events SET source = "whoop", content = "b"').collect();

  const tick = createTriggerTick({ db, engine, dispatchTool: async () => {} });
  await tick();

  const cur = await readTriggerCursor(db);
  assert.ok(cur.last_event_ts, 'cursor ts written');
  assert.ok(cur.last_event_id, 'cursor id written');
  // Second tick: no new events, no work.
  const r2 = await tick();
  assert.equal(r2.processed, 0);
  await close(db);
});

test('tick continues past events that throw', async () => {
  const db = await fresh();
  const engine = createTriggerEngine({ sleep: async () => {}, logger: quietLogger() });
  let calls = 0;
  // Monkey-patch processEvent to throw on the first event.
  const origProcess = engine.processEvent;
  engine.processEvent = async (args) => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return origProcess(args);
  };
  engine.register({ name: 't', on: 'whoop', do: [{ tool: 'x' }] });
  await db.query('CREATE events SET source = "whoop", content = "first"').collect();
  await new Promise((r) => setTimeout(r, 2));
  await db.query('CREATE events SET source = "whoop", content = "second"').collect();
  await new Promise((r) => setTimeout(r, 2));
  await db.query('CREATE events SET source = "whoop", content = "third"').collect();

  const tick = createTriggerTick({
    db,
    engine,
    dispatchTool: async () => {},
    logger: quietLogger(),
  });
  const r = await tick();
  // Three events processed even though one threw.
  assert.equal(r.processed, 3);
  // Cursor advanced past 'third'.
  const cur = await readTriggerCursor(db);
  assert.ok(cur.last_event_ts);
  await close(db);
});

test('tick respects batchSize', async () => {
  const db = await fresh();
  const engine = createTriggerEngine({ sleep: async () => {}, logger: quietLogger() });
  engine.register({ name: 't', on: 'whoop', do: [{ tool: 'x' }] });
  for (let i = 0; i < 5; i += 1) {
    await db.query(`CREATE events SET source = "whoop", content = "${i}"`).collect();
    await new Promise((r) => setTimeout(r, 1));
  }
  const tick = createTriggerTick({
    db,
    engine,
    dispatchTool: async () => {},
    batchSize: 2,
  });
  const r1 = await tick();
  assert.equal(r1.processed, 2);
  const r2 = await tick();
  assert.equal(r2.processed, 2);
  const r3 = await tick();
  assert.equal(r3.processed, 1);
  const r4 = await tick();
  assert.equal(r4.processed, 0);
  await close(db);
});

test('cooldown across tick boundaries blocks repeat fires', async () => {
  const db = await fresh();
  const engine = createTriggerEngine({ sleep: async () => {}, logger: quietLogger() });
  const dispatched = [];
  engine.register({
    name: 'low-recovery',
    on: 'whoop',
    cooldownMs: 60 * 60_000, // 1h
    do: [{ tool: 'macos_notify', args: { title: 'low' } }],
  });
  await db.query('CREATE events SET source = "whoop", content = "1"').collect();
  const tick = createTriggerTick({
    db,
    engine,
    dispatchTool: async (tool) => dispatched.push(tool),
  });
  // First tick: fires once.
  const r1 = await tick();
  assert.equal(r1.fired, 1);
  assert.equal(dispatched.length, 1);

  // New event arrives — cooldown should block.
  await new Promise((r) => setTimeout(r, 5));
  await db.query('CREATE events SET source = "whoop", content = "2"').collect();
  const r2 = await tick();
  assert.equal(r2.fired, 0);
  assert.equal(dispatched.length, 1);
  await close(db);
});
