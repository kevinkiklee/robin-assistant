import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedUser, isAllowedContext } from '../../../user-data/scripts/lib/discord/auth.js';

const allow = { allowedUserIds: ['111', '222'], allowedGuildId: 'g1' };

test('isAllowedUser: matches', () => {
  assert.equal(isAllowedUser('111', allow), true);
  assert.equal(isAllowedUser('222', allow), true);
  assert.equal(isAllowedUser('333', allow), false);
});

test('isAllowedContext: DM from allowed user → true', () => {
  const msg = { author: { id: '111' }, guildId: null };
  assert.equal(isAllowedContext(msg, allow), true);
});

test('isAllowedContext: DM from non-allowed user → false', () => {
  const msg = { author: { id: '999' }, guildId: null };
  assert.equal(isAllowedContext(msg, allow), false);
});

test('isAllowedContext: guild message in allowed guild from allowed user → true', () => {
  const msg = { author: { id: '111' }, guildId: 'g1' };
  assert.equal(isAllowedContext(msg, allow), true);
});

test('isAllowedContext: guild message in WRONG guild → false', () => {
  const msg = { author: { id: '111' }, guildId: 'g-other' };
  assert.equal(isAllowedContext(msg, allow), false);
});

test('isAllowedContext: guild message from non-allowed user → false', () => {
  const msg = { author: { id: '999' }, guildId: 'g1' };
  assert.equal(isAllowedContext(msg, allow), false);
});
