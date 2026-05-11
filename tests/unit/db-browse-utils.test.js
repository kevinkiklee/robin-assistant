// Unit tests for the loopback Host/Origin validators used by the DB browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHostAllowed, isOriginAllowed } from '../../src/db/browse/utils.js';

test('isHostAllowed: rejects empty / non-loopback / port-mismatch', () => {
  assert.equal(isHostAllowed('', 9999), false);
  assert.equal(isHostAllowed(undefined, 9999), false);
  assert.equal(isHostAllowed('example.com:9999', 9999), false);
  assert.equal(isHostAllowed('127.0.0.1:1234', 9999), false);
});

test('isHostAllowed: accepts 127.0.0.1, localhost, ::1', () => {
  assert.equal(isHostAllowed('127.0.0.1:9999', 9999), true);
  assert.equal(isHostAllowed('localhost:9999', 9999), true);
  assert.equal(isHostAllowed('[::1]:9999', 9999), true);
  // No port set means we cannot verify port; still allowed if hostname is loopback.
  assert.equal(isHostAllowed('localhost', 9999), true);
});

test('isOriginAllowed: missing Origin is allowed (same-origin GET)', () => {
  assert.equal(isOriginAllowed(undefined, 9999), true);
  assert.equal(isOriginAllowed('', 9999), true);
});

test('isOriginAllowed: rejects cross-origin', () => {
  assert.equal(isOriginAllowed('http://evil.example.com', 9999), false);
  assert.equal(isOriginAllowed('http://127.0.0.1:1234', 9999), false);
});

test('isOriginAllowed: accepts loopback origins on the expected port', () => {
  assert.equal(isOriginAllowed('http://127.0.0.1:9999', 9999), true);
  assert.equal(isOriginAllowed('http://localhost:9999', 9999), true);
  assert.equal(isOriginAllowed('http://[::1]:9999', 9999), true);
});
