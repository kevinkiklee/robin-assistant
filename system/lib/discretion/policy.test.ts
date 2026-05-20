import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkInbound, checkOutbound } from './policy.ts';

test('checkOutbound: passes plain prose', () => {
  assert.deepEqual(checkOutbound({ text: 'hello world' }), { ok: true });
});

test('checkOutbound: refuses valid Luhn credit card', () => {
  // 4242 4242 4242 4242 — Stripe's standard test PAN, Luhn-valid
  const r = checkOutbound({ text: 'card is 4242 4242 4242 4242 please' });
  assert.equal(r.ok, false);
  assert.equal(r.ok ? null : r.reason, 'pii:credit_card');
});

test('checkOutbound: ignores non-Luhn digit runs', () => {
  // 16 random digits, not Luhn-valid
  const r = checkOutbound({ text: 'tracking 1234567812345678 — not a card' });
  assert.equal(r.ok, true);
});

test('checkOutbound: refuses SSN-shaped pattern', () => {
  const r = checkOutbound({ text: 'my ssn is 123-45-6789' });
  assert.equal(r.ok, false);
  assert.equal(r.ok ? null : r.reason, 'pii:ssn');
});

test('checkOutbound: refuses common credential shapes', () => {
  const cases = [
    ['openai_key', 'leaked sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA in chat'],
    ['anthropic_key', 'leaked sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['github_token', 'token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA here'],
    ['aws_access_key', 'access AKIAIOSFODNN7EXAMPLE'],
    ['google_api_key', 'key AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['stripe_key', 'use sk_live_AAAAAAAAAAAAAAAAAAAAAAAA in prod'],
  ];
  for (const [name, text] of cases) {
    const r = checkOutbound({ text });
    assert.equal(r.ok, false, `expected refuse for ${name} in: ${text}`);
    assert.equal(r.ok ? null : r.reason, `secret:${name}`);
  }
});

test('checkOutbound: PII guard applies even on trusted origin', () => {
  const r = checkOutbound({
    text: '123-45-6789',
    origin: 'discord:dm:u1',
    trustedOrigins: ['discord:dm:u1'],
  });
  assert.equal(r.ok, false);
});

test('checkOutbound: trusted origin matches exact + :-bounded prefix', () => {
  // No PII/secrets — just verifies origin shortcut returns ok.
  assert.equal(
    checkOutbound({
      text: 'safe content',
      origin: 'discord:guild:G1:channel:C2',
      trustedOrigins: ['discord:guild:G1'],
    }).ok,
    true,
  );
  assert.equal(
    checkOutbound({
      text: 'safe content',
      origin: 'discord:guild:G123',
      trustedOrigins: ['discord:guild:G1'],
    }).ok,
    true,
  );
});

test('checkInbound: passes prose, refuses credential shapes + PEM + JWT', () => {
  assert.equal(checkInbound('I had surgery in 2024').ok, true);
  assert.equal(checkInbound('').ok, true);
  const pem = checkInbound('-----BEGIN PRIVATE KEY-----');
  assert.equal(pem.ok, false);
  assert.equal(pem.ok ? null : pem.reason, 'secret:private_key_pem');
  const jwt = checkInbound('token eyJhbGciOiJIUzI1.eyJzdWIiOiJ1.SflKxwRJSMeKKF here');
  assert.equal(jwt.ok, false);
  const pw = checkInbound('password=hunter2hunter2');
  assert.equal(pw.ok, false);
});
