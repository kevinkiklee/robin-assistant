import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, fingerprint, loadCredentials } from './config.ts';

const ALL = {
  CLAUDE_TOKEN_ROBIN: 'sk-ant-oat01-FAKE-robin',
  CLAUDE_TOKEN_SHARED: 'sk-ant-oat01-FAKE-shared',
  CLAUDE_CREDIT_KEY_ROBIN: 'sk-ant-api03-FAKE-credit',
  CLAUDE_CREDIT_KEY_SHARED: 'sk-ant-api03-FAKE-credit-shared',
};

test('credentials: loads in order', () => {
  const cs = loadCredentials(ALL);
  assert.deepEqual(
    cs.map((c) => c.id),
    ['robin:subscription', 'shared:subscription', 'robin:credit', 'shared:credit'],
  );
  assert.deepEqual(cs[0].env, {
    set: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FAKE-robin' },
    unset: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  });
  assert.deepEqual(cs[2].env, {
    set: { ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE-credit' },
    unset: ['CLAUDE_CODE_OAUTH_TOKEN'],
  });
  assert.equal(cs[0].fingerprint, fingerprint('sk-ant-oat01-FAKE-robin'));
  assert.match(cs[0].fingerprint, /^[0-9a-f]{12}$/);
});

test('credentials: ignores blanks and trims', () => {
  assert.deepEqual(loadCredentials({}), []);
  const cs = loadCredentials({ CLAUDE_TOKEN_SHARED: '  ', CLAUDE_TOKEN_ROBIN: '  tok \n' });
  assert.deepEqual(
    cs.map((c) => c.id),
    ['robin:subscription'],
  );
  assert.equal(cs[0].env.set.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
});

test('credentials: describe never shows secret', () => {
  for (const c of loadCredentials(ALL)) {
    const d = describe(c);
    assert.ok(!d.includes('FAKE'));
    assert.ok(d.includes(c.fingerprint));
  }
  assert.match(describe(loadCredentials(ALL)[0]), /^robin \(subscription, [0-9a-f]{12}\)$/);
});
