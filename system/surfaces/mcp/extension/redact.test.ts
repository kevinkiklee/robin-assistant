import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactIntegrationStateRows } from './redact.ts';

test('redact: masks an access token but keeps the row and its key visible', () => {
  const rows = redactIntegrationStateRows([
    {
      integration_name: 'whoop',
      key: 'whoop_access_token',
      value: 'abc123secret',
      updated_at: 't',
    },
  ]);

  assert.equal(rows[0].key, 'whoop_access_token', 'the key must stay — it is the diagnostic');
  assert.equal(rows[0].integration_name, 'whoop');
  assert.equal(rows[0].updated_at, 't', 'rotation time is the whole point of looking');
  assert.ok(!String(rows[0].value).includes('abc123secret'), 'secret must not survive');
  assert.match(String(rows[0].value), /redacted/i);
});

test('redact: reports the length so "is it set / did it rotate" stays answerable', () => {
  const rows = redactIntegrationStateRows([
    {
      integration_name: 'whoop',
      key: 'whoop_refresh_token',
      value: 'x'.repeat(88),
      updated_at: 't',
    },
  ]);
  assert.match(String(rows[0].value), /88/);
});

test('redact: leaves ordinary operational state alone', () => {
  const rows = redactIntegrationStateRows([
    { integration_name: 'whoop', key: 'last_ingest_count', value: '7', updated_at: 't' },
    {
      integration_name: 'whoop',
      key: 'cursor_recovery',
      value: '2025-03-14T08:05:00.000Z',
      updated_at: 't',
    },
    { integration_name: 'whoop', key: 'consecutive_errors', value: '0', updated_at: 't' },
  ]);
  assert.equal(rows[0].value, '7');
  assert.equal(rows[1].value, '2025-03-14T08:05:00.000Z');
  assert.equal(rows[2].value, '0');
});

test('redact: token EXPIRY is metadata, not a secret — it must stay readable', () => {
  // The expiry is exactly what you open integration_status to check when an
  // OAuth grant is misbehaving; redacting it would defeat the tool.
  const rows = redactIntegrationStateRows([
    {
      integration_name: 'whoop',
      key: 'whoop_access_token_expiry',
      value: '1741939500000',
      updated_at: 't',
    },
  ]);
  assert.equal(rows[0].value, '1741939500000');
});

test('redact: covers the other common secret shapes', () => {
  for (const key of [
    'client_secret',
    'api_key',
    'apiKey',
    'password',
    'private_key',
    'bearer',
    'session_cookie',
    'plaid_credential',
  ]) {
    const rows = redactIntegrationStateRows([
      { integration_name: 'x', key, value: 'LEAKME', updated_at: 't' },
    ]);
    assert.ok(!String(rows[0].value).includes('LEAKME'), `${key} should be redacted`);
  }
});

test('redact: a null or absent value does not crash', () => {
  const rows = redactIntegrationStateRows([
    { integration_name: 'x', key: 'whoop_access_token', value: null, updated_at: 't' },
    { integration_name: 'x', key: 'other', updated_at: 't' },
  ]);
  assert.equal(rows.length, 2);
});

test('redact: does not mutate the rows it was given', () => {
  const original = [
    {
      integration_name: 'whoop',
      key: 'whoop_access_token',
      value: 'abc123secret',
      updated_at: 't',
    },
  ];
  redactIntegrationStateRows(original);
  assert.equal(original[0].value, 'abc123secret');
});
