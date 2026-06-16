import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSONAL_DOMAINS, isPersonalDomain } from './domains.ts';

test('PERSONAL_DOMAINS is the closed 11-domain set', () => {
  assert.equal(PERSONAL_DOMAINS.length, 11);
  assert.ok(PERSONAL_DOMAINS.includes('health'));
  assert.ok(PERSONAL_DOMAINS.includes('directives'));
});

test('isPersonalDomain accepts members, rejects everything else', () => {
  assert.equal(isPersonalDomain('finance'), true);
  assert.equal(isPersonalDomain('directives'), true);
  assert.equal(isPersonalDomain('engineering'), false);
  assert.equal(isPersonalDomain('library'), false);
  assert.equal(isPersonalDomain(''), false);
  assert.equal(isPersonalDomain(null), false);
  assert.equal(isPersonalDomain(undefined), false);
});
