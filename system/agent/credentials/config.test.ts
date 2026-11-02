import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { CREDENTIAL_SOURCE_VARS, describe, fingerprint, loadCredentials } from './config.ts';

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

test('credentials: serialisation never carries the secret', () => {
  const [c] = loadCredentials({ CLAUDE_TOKEN_ROBIN: 'sk-ant-oat01-FAKE-robin' });
  const json = JSON.stringify(c);
  assert.doesNotMatch(json, /FAKE/);
  assert.deepEqual(JSON.parse(json), {
    id: 'robin:subscription',
    name: 'robin',
    kind: 'subscription',
    fingerprint: c.fingerprint,
  });
  assert.equal('env' in { ...c }, false);
  assert.doesNotMatch(JSON.stringify({ ...c }), /FAKE/);
  assert.doesNotMatch(JSON.stringify({ wrapped: [c] }), /FAKE/);
  assert.doesNotMatch(JSON.stringify(c.env), /FAKE/);
  assert.doesNotMatch(inspect(c, { depth: 5 }), /FAKE/);
  // the SDK child still gets the real value
  assert.equal(c.env.set.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-FAKE-robin');
  assert.equal({ ...c.env.set }.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-FAKE-robin');
});

test('credentials: CREDENTIAL_SOURCE_VARS lists every source var', () => {
  assert.deepEqual([...CREDENTIAL_SOURCE_VARS].sort(), Object.keys(ALL).sort());
});
