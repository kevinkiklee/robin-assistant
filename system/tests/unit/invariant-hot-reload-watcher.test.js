import test from 'node:test';
import assert from 'node:assert';
import invariant from '../../runtime/invariants/runtime.hot-reload-watcher-active.js';

test('ok when watcher state row exists with active=true', async () => {
  const ctx = {
    db: {
      query: () => ({
        collect: async () => [{ active: true, registered_at: new Date().toISOString() }],
      }),
    },
  };
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, true);
});

test('warn when watcher state row missing', async () => {
  const ctx = { db: { query: () => ({ collect: async () => [] }) } };
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, false);
  assert.match(r.error ?? '', /watcher|register/);
});

test('warn when active=false', async () => {
  const ctx = {
    db: {
      query: () => ({
        collect: async () => [{ active: false, registered_at: new Date().toISOString() }],
      }),
    },
  };
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, false);
  assert.match(r.error ?? '', /inactive|watcher/);
});

test('detect-only mode (no repair)', () => {
  assert.strictEqual(invariant.repair, undefined);
  assert.strictEqual(invariant.detectOnly, true);
});
