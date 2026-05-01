import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precheckAction } from '../scripts/lib/actions/precheck.js';

test('clean call passes', () => {
  const r = precheckAction({
    class: 'gmail-archive',
    params: { thread_id: 'abc123' },
    policies: { auto: ['gmail-archive'], never: [] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.fallback, null);
});

test('explicit NEVER in policies blocks', () => {
  const r = precheckAction({
    class: 'gmail-send-new-thread',
    params: { to: 'a@b.com', body: 'hi' },
    policies: { auto: [], never: ['gmail-send-new-thread'] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'BLOCK');
  assert.match(r.reason, /never/i);
});

test('SSN in params blocks (privacy)', () => {
  const r = precheckAction({
    class: 'write-memory-file',
    params: { content: 'My SSN is 123-45-6789, file me away.' },
    policies: { auto: ['write-memory-file'], never: [] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'BLOCK');
  assert.match(r.reason, /privacy/i);
});

test('credit-card-shaped number in params blocks', () => {
  const r = precheckAction({
    class: 'write-memory-file',
    params: { content: 'card: 4111-1111-1111-1111' },
    policies: { auto: ['write-memory-file'], never: [] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'BLOCK');
});

test('last-4 of card is allowed', () => {
  const r = precheckAction({
    class: 'write-memory-file',
    params: { content: 'card ending in 1111' },
    policies: { auto: ['write-memory-file'], never: [] },
  });
  assert.equal(r.ok, true);
});

test('dollar amount > $1000 forces ASK', () => {
  const r = precheckAction({
    class: 'gmail-send-new-thread',
    params: { body: 'wire $5,000 to vendor' },
    policies: { auto: ['gmail-send-new-thread'], never: [] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'ASK');
  assert.match(r.reason, /dollar/i);
});

test('dollar amount ≤ $1000 passes', () => {
  const r = precheckAction({
    class: 'gmail-send-new-thread',
    params: { body: 'lunch was $42' },
    policies: { auto: ['gmail-send-new-thread'], never: [] },
  });
  assert.equal(r.ok, true);
});

test('health/legal keyword forces ASK', () => {
  const r = precheckAction({
    class: 'write-memory-file',
    params: { content: 'diagnosis: anaphylaxis; epinephrine 0.3mg' },
    policies: { auto: ['write-memory-file'], never: [] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'ASK');
  assert.match(r.reason, /health|legal|stress/i);
});

test('credentials/api key shape blocks', () => {
  const r = precheckAction({
    class: 'write-memory-file',
    params: { content: 'sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCdEfGh' },
    policies: { auto: ['write-memory-file'], never: [] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'BLOCK');
  assert.match(r.reason, /credential|secret/i);
});

test('explicit NEVER beats AUTO', () => {
  const r = precheckAction({
    class: 'gmail-archive',
    params: {},
    policies: { auto: ['gmail-archive'], never: ['gmail-archive'] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'BLOCK');
});
