// system/tests/lib/__tests__/stubs.test.js
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStubs, uninstallStubs, getLedger, hasBlockEvents } from '../stubs.js';

describe('stubs', () => {
  afterEach(() => uninstallStubs());

  it('blocked fetch records block event and throws', async () => {
    installStubs({ fetch: [] });
    await assert.rejects(() => fetch('https://example.com/foo'), /NetworkBlocked/);
    const ledger = getLedger();
    assert.equal(ledger[0].event, 'block');
    assert.equal(ledger[0].host, 'example.com');
    assert.equal(ledger[0].path, '/foo');
    assert.equal(hasBlockEvents(), true);
  });

  it('matched fetch returns stub response and records call', async () => {
    installStubs({
      fetch: [{ host: 'api.example.com', method: 'GET', path: '/v1/items', response: { status: 200, body: { items: [1, 2] } } }],
    });
    const res = await fetch('https://api.example.com/v1/items');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { items: [1, 2] });
    assert.equal(getLedger()[0].event, 'call');
    assert.equal(hasBlockEvents(), false);
  });

  it('fetch matcher requires method match', async () => {
    installStubs({
      fetch: [{ host: 'api.example.com', method: 'POST', path: '/v1/items', response: { status: 201 } }],
    });
    // GET should miss, fall through to block.
    await assert.rejects(() => fetch('https://api.example.com/v1/items'), /NetworkBlocked/);
  });

  it('uninstallStubs restores fetch', () => {
    installStubs({ fetch: [] });
    uninstallStubs();
    assert.equal(typeof fetch, 'function');
  });
});
