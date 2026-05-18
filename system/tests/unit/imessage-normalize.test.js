import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appleDateToJsDate,
  classifyService,
  isAllowed,
  isFromMe,
  isGroupChat,
  normalizeHandle,
} from '../../io/integrations/imessage/normalize.js';

test('appleDateToJsDate handles nanosecond format', () => {
  // 2026-05-17 00:00:00 UTC = MAC_EPOCH + 24 years + change.
  // Mac epoch: 2001-01-01. 25 years 4 months 16 days later.
  const nanos = BigInt(Date.UTC(2026, 4, 17) - Date.UTC(2001, 0, 1)) * 1_000_000n;
  const d = appleDateToJsDate(nanos);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 4);
  assert.equal(d.getUTCDate(), 17);
});

test('appleDateToJsDate handles legacy seconds-since-epoch rows', () => {
  // Pre-Catalina: stored as seconds, e.g. 500 million seconds since 2001.
  const seconds = 500_000_000n;
  const d = appleDateToJsDate(seconds);
  assert.equal(d.getUTCFullYear(), 2016); // 2001 + ~15.85 years
});

test('appleDateToJsDate returns null for null/undefined', () => {
  assert.equal(appleDateToJsDate(null), null);
  assert.equal(appleDateToJsDate(undefined), null);
});

test('normalizeHandle strips e: prefix and lowercases', () => {
  assert.equal(normalizeHandle('e:Foo@Bar.com'), 'foo@bar.com');
  assert.equal(normalizeHandle('+15551234567'), '+15551234567');
  assert.equal(normalizeHandle('  USER@x.io  '), 'user@x.io');
});

test('normalizeHandle returns null for empty/nullish', () => {
  assert.equal(normalizeHandle(null), null);
  assert.equal(normalizeHandle(''), null);
  assert.equal(normalizeHandle('   '), null);
});

test('isGroupChat detects style=43', () => {
  assert.equal(isGroupChat(43), true);
  assert.equal(isGroupChat(45), false);
  assert.equal(isGroupChat(null), false);
});

test('classifyService maps iMessage / SMS / unknown', () => {
  assert.equal(classifyService('iMessage'), 'imessage');
  assert.equal(classifyService('SMS'), 'sms-continuity');
  assert.equal(classifyService('Other'), 'other');
  assert.equal(classifyService(null), 'unknown');
});

test('isFromMe handles 1 / true / falsy', () => {
  assert.equal(isFromMe({ is_from_me: 1 }), true);
  assert.equal(isFromMe({ is_from_me: true }), true);
  assert.equal(isFromMe({ is_from_me: 0 }), false);
  assert.equal(isFromMe({ is_from_me: false }), false);
  assert.equal(isFromMe(null), false);
});

test('isAllowed: DM matches by handle in directHandles', () => {
  const allow = { directHandles: new Set(['+15551234567']), groupChats: new Set() };
  assert.equal(isAllowed({ chat_style: 45, handle: '+15551234567' }, allow), true);
  assert.equal(isAllowed({ chat_style: 45, handle: '+19999999999' }, allow), false);
});

test('isAllowed: group matches by chat_guid in groupChats', () => {
  const allow = { directHandles: new Set(), groupChats: new Set(['CHAT-GUID-1']) };
  assert.equal(
    isAllowed({ chat_style: 43, chat_guid: 'CHAT-GUID-1', handle: 'anybody' }, allow),
    true,
  );
  assert.equal(isAllowed({ chat_style: 43, chat_guid: 'OTHER', handle: 'anybody' }, allow), false);
});

test('isAllowed: group membership does NOT auto-allow direct messages from same handle', () => {
  const allow = { directHandles: new Set(), groupChats: new Set(['CHAT-1']) };
  assert.equal(isAllowed({ chat_style: 45, handle: 'someone@x.com' }, allow), false);
});

test('isAllowed normalizes the handle on lookup', () => {
  const allow = { directHandles: new Set(['user@x.com']), groupChats: new Set() };
  assert.equal(isAllowed({ chat_style: 45, handle: 'e:USER@X.com' }, allow), true);
});

test('isAllowed: missing row or allowlist is denied', () => {
  assert.equal(isAllowed(null, { directHandles: new Set(), groupChats: new Set() }), false);
  assert.equal(isAllowed({ chat_style: 45, handle: 'a' }, null), false);
});
