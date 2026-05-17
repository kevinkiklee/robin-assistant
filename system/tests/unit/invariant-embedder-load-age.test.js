import test from 'node:test';
import assert from 'node:assert';
import invariant from '../../runtime/invariants/daemon.embedder-load-age.js';

function makeCtx({ lastSuccessTs }) {
  return {
    db: {
      query: () => ({
        collect: async () => [{ last_success_ts: lastSuccessTs }],
      }),
    },
  };
}

test('ok when synthetic embed succeeded within 24h', async () => {
  const recent = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const r = await invariant.check(makeCtx({ lastSuccessTs: recent }));
  assert.strictEqual(r.ok, true);
});

test('warn when synthetic embed has not succeeded in >24h', async () => {
  const stale = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  const r = await invariant.check(makeCtx({ lastSuccessTs: stale }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error ?? '', /stale|24h|probe/);
});

test('warn when no synthetic embed row exists', async () => {
  const r = await invariant.check({ db: { query: () => ({ collect: async () => [] }) } });
  assert.strictEqual(r.ok, false);
});

test('runs in detect-only mode for 7 days after install (no repair)', () => {
  assert.strictEqual(invariant.repair, undefined);
  assert.strictEqual(invariant.detectOnly, true);
});
