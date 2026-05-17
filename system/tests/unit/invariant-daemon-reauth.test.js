import test from 'node:test';
import assert from 'node:assert';
import invariant from '../../runtime/invariants/mcp.daemon-authenticated-after-reconnect.js';

function makeCtx({ activeQueryCount = 0, reconnectThrows = null, probeSucceeds = true }) {
  let reconnected = false;
  return {
    activeQueryCount,
    db: {
      close: async () => {},
      connect: async () => {
        reconnected = true;
        if (reconnectThrows) throw reconnectThrows;
      },
      query: () => ({
        collect: async () => {
          if (!probeSucceeds) {
            const e = new Error('Anonymous access not allowed');
            e.code = 'ANON';
            throw e;
          }
          return [{ v: 1 }];
        },
      }),
    },
    _wasReconnected: () => reconnected,
  };
}

test('skips when active queries in flight', async () => {
  const ctx = makeCtx({ activeQueryCount: 3 });
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, 'workload_active');
});

test('ok when reconnect + probe succeed', async () => {
  const ctx = makeCtx({ activeQueryCount: 0, probeSucceeds: true });
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, true);
});

test('warn when probe surfaces anonymous-access after reconnect', async () => {
  const ctx = makeCtx({ activeQueryCount: 0, probeSucceeds: false });
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, false);
  assert.match(r.error ?? '', /anonymous|reauth/);
});

test('warn when reconnect throws', async () => {
  const ctx = makeCtx({ activeQueryCount: 0, reconnectThrows: new Error('conn refused') });
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, false);
});

test('weekly cadence configured', () => {
  assert.strictEqual(invariant.runWhen.heartbeat.cooldownMs, 7 * 24 * 3600 * 1000);
});

test('detectOnly is true', () => {
  assert.strictEqual(invariant.detectOnly, true);
});
