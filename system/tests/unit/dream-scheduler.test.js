import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDag } from '../../cognition/dream/scheduler.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('empty graph returns empty summary, no layers, halted=null', async () => {
  const r = await runDag({}, {});
  assert.deepEqual(r.summary, {});
  assert.deepEqual(r.layers, []);
  assert.equal(r.halted, null);
});

test('single step runs and returns its result', async () => {
  const r = await runDag({ a: async () => 1 }, { a: [] });
  assert.equal(r.summary.a, 1);
  assert.equal(r.layers.length, 1);
  assert.deepEqual(r.layers[0].names, ['a']);
});

test('linear chain a → b → c produces 3 layers; b starts only after a settles', async () => {
  const events = [];
  const r = await runDag(
    {
      a: async () => {
        events.push('a-start');
        await sleep(20);
        events.push('a-end');
        return 'A';
      },
      b: async () => {
        events.push('b-start');
        await sleep(20);
        events.push('b-end');
        return 'B';
      },
      c: async () => {
        events.push('c-start');
        return 'C';
      },
    },
    { a: [], b: ['a'], c: ['b'] },
  );
  assert.equal(r.summary.a, 'A');
  assert.equal(r.summary.b, 'B');
  assert.equal(r.summary.c, 'C');
  // b-start must come AFTER a-end (linear chain).
  assert.ok(events.indexOf('b-start') > events.indexOf('a-end'));
  assert.ok(events.indexOf('c-start') > events.indexOf('b-end'));
  assert.equal(r.layers.length, 3);
});

test('diamond a → {b, c} → d: b and c run concurrently', async () => {
  const starts = [];
  const r = await runDag(
    {
      a: async () => 'A',
      b: async () => {
        starts.push({ name: 'b', t: Date.now() });
        await sleep(30);
        return 'B';
      },
      c: async () => {
        starts.push({ name: 'c', t: Date.now() });
        await sleep(30);
        return 'C';
      },
      d: async () => 'D',
    },
    { a: [], b: ['a'], c: ['a'], d: ['b', 'c'] },
  );
  assert.equal(r.summary.d, 'D');
  // Layer-2 b and c started within ~10ms of each other (concurrent).
  const tb = starts.find((s) => s.name === 'b').t;
  const tc = starts.find((s) => s.name === 'c').t;
  assert.ok(Math.abs(tb - tc) < 15, `expected concurrent start, |Δt|=${Math.abs(tb - tc)}ms`);
  assert.equal(r.layers.length, 3);
  assert.deepEqual([...r.layers[1].names].sort(), ['b', 'c']);
});

test('step throw is captured into summary.<name>.error; sibling and downstream still run', async () => {
  const r = await runDag(
    {
      a: async () => {
        throw new Error('boom');
      },
      sib: async () => 'sib-ok',
      b: async () => 'b-ok',
    },
    { a: [], sib: [], b: ['a'] },
  );
  assert.deepEqual(r.summary.a, { error: 'boom' });
  assert.equal(r.summary.sib, 'sib-ok');
  // Dep on a settled (with error), so b runs (today's serial behaviour).
  assert.equal(r.summary.b, 'b-ok');
});

test('step throws non-Error → summary.<name>.error stringifies the value', async () => {
  const r = await runDag(
    {
      // biome-ignore lint/suspicious/useAwait: deliberate non-Error throw test
      a: async () => {
        // biome-ignore lint/correctness/noUnreachable: deliberate non-Error throw
        throw 'just a string';
      },
    },
    { a: [] },
  );
  assert.deepEqual(r.summary.a, { error: 'just a string' });
});

test('shouldHalt returns true at a layer boundary → remaining steps skipped', async () => {
  let layerIdx = 0;
  const r = await runDag(
    {
      a: async () => 'A',
      b: async () => 'B',
      c: async () => 'C',
    },
    { a: [], b: ['a'], c: ['b'] },
    {
      shouldHalt: async () => {
        // Halt after layer 1 (a) settles, before layer 2.
        layerIdx++;
        return layerIdx > 1;
      },
    },
  );
  assert.equal(r.summary.a, 'A');
  assert.deepEqual(r.summary.b, { skipped: 'budget_exhausted' });
  assert.deepEqual(r.summary.c, { skipped: 'budget_exhausted' });
  assert.equal(r.halted, 'budget_exhausted');
});

test('shouldHalt true on first call → every step skipped', async () => {
  const r = await runDag(
    { a: async () => 'A', b: async () => 'B' },
    { a: [], b: ['a'] },
    { shouldHalt: async () => true },
  );
  assert.deepEqual(r.summary.a, { skipped: 'budget_exhausted' });
  assert.deepEqual(r.summary.b, { skipped: 'budget_exhausted' });
  assert.equal(r.halted, 'budget_exhausted');
});

test('maxConcurrent caps in-layer parallelism', async () => {
  const starts = [];
  let inflight = 0;
  let peak = 0;
  const fn = (name) => async () => {
    inflight++;
    peak = Math.max(peak, inflight);
    starts.push({ name, t: Date.now() });
    await sleep(20);
    inflight--;
    return name;
  };
  await runDag(
    { a: fn('a'), b: fn('b'), c: fn('c'), d: fn('d'), e: fn('e') },
    { a: [], b: [], c: [], d: [], e: [] },
    { maxConcurrent: 2 },
  );
  assert.ok(peak <= 2, `expected peak ≤ 2 under maxConcurrent=2, got ${peak}`);
});

test('cycle detection throws a clear error', async () => {
  await assert.rejects(
    () =>
      runDag(
        { a: async () => 'A', b: async () => 'B' },
        { a: ['b'], b: ['a'] },
      ),
    /cycle/i,
  );
});
