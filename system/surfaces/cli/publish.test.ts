import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishModeError } from './publish.ts';

test('publishModeError: accepts every live mode', () => {
  for (const mode of ['default', 'overwrite', 'as-new', 'delete', 'recategorize', 'thumbs']) {
    assert.equal(publishModeError(mode), null, mode);
  }
});

test('publishModeError: --mode sync says it was removed, not "unknown"', () => {
  const msg = publishModeError('sync') ?? '';
  assert.match(msg, /mode sync was removed/);
  assert.match(msg, /dashboard/);
  assert.doesNotMatch(msg, /unknown mode/);
});

test('publishModeError: an unknown mode lists the valid ones, without sync', () => {
  const msg = publishModeError('bogus') ?? '';
  assert.match(msg, /unknown mode: bogus/);
  assert.match(msg, /recategorize \| thumbs/);
  assert.doesNotMatch(msg, /sync/);
});
