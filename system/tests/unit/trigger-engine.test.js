import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTriggerEngine } from '../../cognition/triggers/engine.js';

function makeEngine(opts = {}) {
  return createTriggerEngine({
    sleep: async () => {},
    logger: { warn: () => {} },
    ...opts,
  });
}

test('register validates trigger shape', () => {
  const engine = makeEngine();
  assert.throws(() => engine.register({}), /trigger\.name/);
  assert.throws(() => engine.register({ name: 'x' }), /on required/);
  assert.throws(() => engine.register({ name: 'x', on: 'whoop' }), /do must be a non-empty/);
  assert.throws(
    () => engine.register({ name: 'x', on: 'whoop', do: [{}] }),
    /action\.tool required/,
  );
  assert.throws(
    () => engine.register({ name: 'x', on: 'whoop', when: 'not a fn', do: [{ tool: 'a' }] }),
    /when must be a function/,
  );
});

test('processEvent dispatches matching trigger', async () => {
  const engine = makeEngine();
  const calls = [];
  engine.register({
    name: 't',
    on: 'whoop',
    do: [{ tool: 'macos_notify', args: { title: 'hi' } }],
  });
  const r = await engine.processEvent({
    event: { id: 'e1', source: 'whoop' },
    dispatchTool: async (tool, args) => calls.push({ tool, args }),
  });
  assert.equal(r.matched, 1);
  assert.equal(r.fired, 1);
  assert.deepEqual(calls, [{ tool: 'macos_notify', args: { title: 'hi' } }]);
});

test('processEvent skips non-matching triggers', async () => {
  const engine = makeEngine();
  let invoked = 0;
  engine.register({
    name: 't',
    on: 'gmail',
    do: [{ tool: 'macos_notify', args: { title: 'mail' } }],
  });
  const r = await engine.processEvent({
    event: { id: 'e1', source: 'whoop' },
    dispatchTool: async () => {
      invoked += 1;
    },
  });
  assert.equal(r.matched, 0);
  assert.equal(r.fired, 0);
  assert.equal(invoked, 0);
});

test('when predicate filters events', async () => {
  const engine = makeEngine();
  let invoked = 0;
  engine.register({
    name: 'low-recovery',
    on: 'whoop',
    when: ({ event }) => event.recovery < 50,
    do: [{ tool: 'macos_notify', args: { title: 'recovery low' } }],
  });
  const fires = [];
  const high = await engine.processEvent({
    event: { id: 'e1', source: 'whoop', recovery: 70 },
    dispatchTool: async () => {
      invoked += 1;
    },
    recordFire: async (rec) => fires.push(rec),
  });
  assert.equal(high.fired, 0);
  assert.equal(invoked, 0);
  assert.equal(fires[0].status, 'skipped');
  assert.equal(fires[0].reason, 'condition_false');

  const low = await engine.processEvent({
    event: { id: 'e2', source: 'whoop', recovery: 45 },
    dispatchTool: async () => {
      invoked += 1;
    },
  });
  assert.equal(low.fired, 1);
  assert.equal(invoked, 1);
});

test('async when predicate is awaited', async () => {
  const engine = makeEngine();
  let invoked = 0;
  engine.register({
    name: 't',
    on: 'whoop',
    when: async ({ event }) => event.recovery < 50,
    do: [{ tool: 'macos_notify', args: { title: 'low' } }],
  });
  const r = await engine.processEvent({
    event: { id: 'e1', source: 'whoop', recovery: 30 },
    dispatchTool: async () => {
      invoked += 1;
    },
  });
  assert.equal(r.fired, 1);
  assert.equal(invoked, 1);
});

test('when throwing marks fire as failed', async () => {
  const engine = makeEngine();
  engine.register({
    name: 't',
    on: 'whoop',
    when: () => {
      throw new Error('boom');
    },
    do: [{ tool: 'x' }],
  });
  const fires = [];
  const r = await engine.processEvent({
    event: { id: 'e1', source: 'whoop' },
    dispatchTool: async () => assert.fail('should not dispatch'),
    recordFire: async (rec) => fires.push(rec),
  });
  assert.equal(r.fired, 0);
  assert.equal(fires[0].status, 'failed');
  assert.match(fires[0].error, /when threw: boom/);
});

test('cooldown blocks repeat fires within window', async () => {
  const engine = makeEngine();
  const fires = [];
  engine.register({
    name: 't',
    on: 'whoop',
    cooldownMs: 60_000,
    do: [{ tool: 'macos_notify', args: { title: 'x' } }],
  });
  // First event: no previous fire → fires.
  const r1 = await engine.processEvent({
    event: { id: 'e1', source: 'whoop' },
    dispatchTool: async () => {},
    lookupLastFire: async () => null,
    recordFire: async (rec) => fires.push(rec),
  });
  assert.equal(r1.fired, 1);
  // Second event: last fired 10s ago → blocked.
  const r2 = await engine.processEvent({
    event: { id: 'e2', source: 'whoop' },
    dispatchTool: async () => assert.fail('should not dispatch'),
    lookupLastFire: async () => ({ fired_at_ms: Date.now() - 10_000 }),
    recordFire: async (rec) => fires.push(rec),
  });
  assert.equal(r2.fired, 0);
  assert.equal(fires.at(-1).status, 'skipped');
  assert.equal(fires.at(-1).reason, 'cooldown');
  assert.ok(fires.at(-1).cooldown_remaining_ms > 0);
});

test('cooldown does not block after window elapses', async () => {
  const engine = makeEngine();
  engine.register({
    name: 't',
    on: 'whoop',
    cooldownMs: 60_000,
    do: [{ tool: 'macos_notify', args: { title: 'x' } }],
  });
  const r = await engine.processEvent({
    event: { id: 'e1', source: 'whoop' },
    dispatchTool: async () => {},
    lookupLastFire: async () => ({ fired_at_ms: Date.now() - 120_000 }),
  });
  assert.equal(r.fired, 1);
});

test('action retries on failure then succeeds', async () => {
  const engine = makeEngine();
  let attempts = 0;
  engine.register({
    name: 't',
    on: 'whoop',
    do: [
      {
        tool: 'x',
        args: { v: 1 },
        retries: 3,
      },
    ],
  });
  const r = await engine.processEvent({
    event: { id: 'e1', source: 'whoop' },
    dispatchTool: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
    },
  });
  assert.equal(attempts, 3);
  assert.equal(r.fired, 1);
});

test('action gives up after exhausting retries', async () => {
  const engine = makeEngine();
  let attempts = 0;
  engine.register({
    name: 't',
    on: 'whoop',
    do: [{ tool: 'x', retries: 3 }],
  });
  const fires = [];
  const r = await engine.processEvent({
    event: { id: 'e1', source: 'whoop' },
    dispatchTool: async () => {
      attempts += 1;
      throw new Error('permafail');
    },
    recordFire: async (rec) => fires.push(rec),
  });
  assert.equal(attempts, 3);
  assert.equal(r.fired, 0);
  assert.equal(fires[0].status, 'failed');
  assert.match(fires[0].error, /permafail/);
});

test('triggered_by_chain is propagated to dispatched tools', async () => {
  const engine = makeEngine();
  let captured = null;
  engine.register({
    name: 't',
    on: 'whoop',
    do: [{ tool: 'x' }],
  });
  await engine.processEvent({
    event: { id: 'e1', source: 'whoop' },
    dispatchTool: async (_tool, _args, opts) => {
      captured = opts;
    },
  });
  assert.deepEqual(captured?.triggered_by_chain, ['t']);
});

test('cycle protection skips events at max chain depth', async () => {
  const engine = makeEngine({ maxChainDepth: 3 });
  let invoked = 0;
  engine.register({
    name: 't',
    on: 'whoop',
    do: [{ tool: 'x' }],
  });
  const r = await engine.processEvent({
    event: { id: 'e1', source: 'whoop', triggered_by_chain: ['a', 'b', 'c'] },
    dispatchTool: async () => {
      invoked += 1;
    },
  });
  assert.equal(r.skipped_cycle, true);
  assert.equal(invoked, 0);
});

test('priority controls fire order', async () => {
  const engine = makeEngine();
  const order = [];
  engine.register({
    name: 'low-prio',
    on: 'whoop',
    priority: 200,
    do: [{ tool: 'x', args: () => ({ src: 'low' }) }],
  });
  engine.register({
    name: 'high-prio',
    on: 'whoop',
    priority: 50,
    do: [{ tool: 'x', args: () => ({ src: 'high' }) }],
  });
  await engine.processEvent({
    event: { id: 'e1', source: 'whoop' },
    dispatchTool: async (_t, args) => order.push(args.src),
  });
  assert.deepEqual(order, ['high', 'low']);
});

test('args function receives event and may return promise', async () => {
  const engine = makeEngine();
  let captured = null;
  engine.register({
    name: 't',
    on: 'whoop',
    do: [{ tool: 'x', args: async ({ event }) => ({ recovery: event.recovery }) }],
  });
  await engine.processEvent({
    event: { id: 'e1', source: 'whoop', recovery: 42 },
    dispatchTool: async (_t, args) => {
      captured = args;
    },
  });
  assert.deepEqual(captured, { recovery: 42 });
});

test('multiple actions run sequentially', async () => {
  const engine = makeEngine();
  const order = [];
  engine.register({
    name: 't',
    on: 'whoop',
    do: [
      { tool: 'first', args: { i: 1 } },
      { tool: 'second', args: { i: 2 } },
    ],
  });
  await engine.processEvent({
    event: { id: 'e1', source: 'whoop' },
    dispatchTool: async (tool) => {
      order.push(tool);
      await new Promise((r) => setImmediate(r));
    },
  });
  assert.deepEqual(order, ['first', 'second']);
});

test('list returns all registered triggers', () => {
  const engine = makeEngine();
  engine.register({ name: 'a', on: 'whoop', do: [{ tool: 'x' }] });
  engine.register({ name: 'b', on: 'gmail', do: [{ tool: 'y' }] });
  const all = engine.list();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((t) => t.name).sort(), ['a', 'b']);
});

test('unregister removes a trigger', () => {
  const engine = makeEngine();
  engine.register({ name: 'a', on: 'whoop', do: [{ tool: 'x' }] });
  engine.unregister('a');
  assert.equal(engine.list().length, 0);
});

test('processEvent rejects missing event', async () => {
  const engine = makeEngine();
  await assert.rejects(engine.processEvent({ dispatchTool: async () => {} }), /event is required/);
});
