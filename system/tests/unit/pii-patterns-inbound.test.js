import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkInbound, INBOUND_DENY_PATTERNS } from '../../src/hooks/pii-patterns.js';

// Sanity: the inbound list is the SECRET_PATTERNS set + 3 extras.
test('INBOUND_DENY_PATTERNS contains expected rule names', () => {
  const names = INBOUND_DENY_PATTERNS.map((r) => r.name).sort();
  assert.deepEqual(names, [
    'anthropic_key',
    'aws_access_key',
    'env_secret_value',
    'github_token',
    'jwt',
    'openai_key',
    'password_assignment',
    'private_key_pem',
  ]);
});

// Table-driven cases: each rule × at least one positive + one negative.
const cases = [
  // ---- openai_key -----------------------------------------------------
  {
    label: 'openai_key positive',
    text: 'token sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345',
    expect: 'secret:openai_key',
  },
  { label: 'openai_key negative (too short)', text: 'sk-short', expect: null },

  // ---- anthropic_key --------------------------------------------------
  {
    label: 'anthropic_key positive',
    text: 'use sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345 for claude',
    expect: 'secret:anthropic_key',
  },
  {
    label: 'anthropic_key negative (plain text)',
    text: 'I called Anthropic about a key issue',
    expect: null,
  },

  // ---- github_token ---------------------------------------------------
  {
    label: 'github_token positive (ghp_)',
    text: 'export GHTOK=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    expect: 'secret:github_token',
  },
  {
    label: 'github_token positive (ghs_)',
    text: 'ghs_abcdefghijklmnopqrstuvwxyz0123456789',
    expect: 'secret:github_token',
  },
  {
    label: 'github_token negative',
    text: 'github status looks fine',
    expect: null,
  },

  // ---- aws_access_key -------------------------------------------------
  {
    label: 'aws_access_key positive',
    text: 'AKIAIOSFODNN7EXAMPLE',
    expect: 'secret:aws_access_key',
  },
  { label: 'aws_access_key negative', text: 'AKIA-not-a-key', expect: null },

  // ---- env_secret_value -----------------------------------------------
  {
    label: 'env_secret_value positive',
    text: 'API_TOKEN = AbCdEfGhIjKlMnOpQrSt',
    expect: 'secret:env_secret_value',
  },
  {
    label: 'env_secret_value negative (short value)',
    text: 'API_TOKEN = abc',
    expect: null,
  },

  // ---- private_key_pem ------------------------------------------------
  {
    label: 'private_key_pem positive (RSA)',
    text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...',
    expect: 'secret:private_key_pem',
  },
  {
    label: 'private_key_pem positive (plain)',
    text: '-----BEGIN PRIVATE KEY-----\nbody',
    expect: 'secret:private_key_pem',
  },
  {
    label: 'private_key_pem negative',
    text: 'we discussed RSA encryption keys',
    expect: null,
  },

  // ---- jwt ------------------------------------------------------------
  {
    label: 'jwt positive',
    text: 'session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    expect: 'secret:jwt',
  },
  { label: 'jwt negative (not a jwt)', text: 'eyJ short', expect: null },

  // ---- password_assignment --------------------------------------------
  {
    label: 'password_assignment positive (= form)',
    text: 'password=hunter2hunter',
    expect: 'secret:password_assignment',
  },
  {
    label: 'password_assignment positive (: form, quoted)',
    text: 'pwd: "supersecret123"',
    expect: 'secret:password_assignment',
  },
  {
    label: 'password_assignment negative (mention only)',
    text: 'I need to reset my password sometime',
    expect: null,
  },

  // ---- general clean negatives ---------------------------------------
  {
    label: 'clean text negative',
    text: 'Karen brought lavender from the garden',
    expect: null,
  },
];

for (const c of cases) {
  test(`checkInbound: ${c.label}`, () => {
    const r = checkInbound(c.text);
    if (c.expect == null) {
      assert.equal(r.ok, true, `expected ok=true for: ${c.text}`);
    } else {
      assert.equal(r.ok, false, `expected ok=false for: ${c.text}`);
      assert.equal(r.reason, c.expect);
    }
  });
}

test('checkInbound: empty / non-string returns ok=true', () => {
  assert.equal(checkInbound('').ok, true);
  assert.equal(checkInbound(undefined).ok, true);
  assert.equal(checkInbound(null).ok, true);
});
