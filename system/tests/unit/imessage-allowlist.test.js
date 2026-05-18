import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadAllowlist, parseAllowlist } from '../../io/integrations/imessage/allowlist.js';

test('parseAllowlist parses handles and chats, normalizing handles', () => {
  const out = parseAllowlist(`
    # comment line
    handle:+15551234567
    handle:e:USER@x.com
    chat:CHAT-GUID-1
    chat:CHAT-GUID-2

    # blank line above, garbage below
    notarealprefix:whatever
  `);
  assert.deepEqual([...out.directHandles].sort(), ['+15551234567', 'user@x.com']);
  assert.deepEqual([...out.groupChats].sort(), ['CHAT-GUID-1', 'CHAT-GUID-2']);
});

test('parseAllowlist trims inline comments', () => {
  const out = parseAllowlist('handle:foo@bar.com  # mom\nchat:GUID1 # dev squad');
  assert.ok(out.directHandles.has('foo@bar.com'));
  assert.ok(out.groupChats.has('GUID1'));
});

test('parseAllowlist returns empty sets for nullish input', () => {
  const out = parseAllowlist(null);
  assert.equal(out.directHandles.size, 0);
  assert.equal(out.groupChats.size, 0);
});

test('loadAllowlist returns empty when file missing', () => {
  const out = loadAllowlist('/tmp/__nope__/never-existed.txt');
  assert.equal(out.directHandles.size, 0);
  assert.equal(out.groupChats.size, 0);
});

test('loadAllowlist reads from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imessage-allow-'));
  const path = join(dir, 'allowlist.txt');
  writeFileSync(path, 'handle:dad@example.com\nchat:GROUP-GUID-X\n', 'utf8');
  const out = loadAllowlist(path);
  assert.ok(out.directHandles.has('dad@example.com'));
  assert.ok(out.groupChats.has('GROUP-GUID-X'));
});
