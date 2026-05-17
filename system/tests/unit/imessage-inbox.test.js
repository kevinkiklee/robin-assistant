import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { pollOnce, readMessagesSince } from '../../io/integrations/imessage/inbox.js';

// Build an in-memory chat.db schema subset that mirrors the real one.
function makeFixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id TEXT,
      service TEXT
    );
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      style INTEGER,
      display_name TEXT
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      text TEXT,
      handle_id INTEGER,
      date INTEGER,
      date_edited INTEGER,
      is_from_me INTEGER DEFAULT 0,
      thread_originator_guid TEXT,
      associated_message_type INTEGER DEFAULT 0
    );
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY,
      filename TEXT,
      mime_type TEXT,
      total_bytes INTEGER,
      uti TEXT
    );
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);
  return db;
}

function seedBasic(db) {
  db.prepare("INSERT INTO handle (ROWID, id, service) VALUES (1, '+15551234567', 'iMessage')").run();
  db.prepare("INSERT INTO handle (ROWID, id, service) VALUES (2, 'dad@x.com', 'iMessage')").run();
  db.prepare("INSERT INTO chat (ROWID, guid, style) VALUES (1, 'CHAT-DM-1', 45)").run();
  db.prepare("INSERT INTO chat (ROWID, guid, style, display_name) VALUES (2, 'CHAT-GROUP-1', 43, 'Family')").run();
}

test('readMessagesSince returns rows with normalized fields', () => {
  const db = makeFixtureDb();
  seedBasic(db);
  // Mac-epoch nanos for 2026-05-17 12:00 UTC.
  const dateNs = BigInt(Date.UTC(2026, 4, 17, 12) - Date.UTC(2001, 0, 1)) * 1_000_000n;
  db.prepare("INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me) VALUES (1, 'M-1', 'hi from dad', 2, ?, 0)").run(dateNs);
  db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1)").run();

  const rows = readMessagesSince(db, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowid, 1);
  assert.equal(rows[0].handle, 'dad@x.com');
  assert.equal(rows[0].text, 'hi from dad');
  assert.equal(rows[0].chat_guid, 'CHAT-DM-1');
  assert.equal(rows[0].chat_style, 45);
  assert.equal(rows[0].is_from_me, false);
  assert.equal(rows[0].service, 'imessage');
  assert.deepEqual(rows[0].attachments, []);
  assert.equal(rows[0].date.getUTCHours(), 12);
  db.close();
});

test('readMessagesSince populates attachments per message', () => {
  const db = makeFixtureDb();
  seedBasic(db);
  db.prepare("INSERT INTO message (ROWID, guid, text, handle_id, date) VALUES (1, 'M-1', '', 1, 0)").run();
  db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1)").run();
  db.prepare("INSERT INTO attachment (ROWID, filename, mime_type, total_bytes, uti) VALUES (10, '/img1.jpg', 'image/jpeg', 12345, 'public.jpeg')").run();
  db.prepare("INSERT INTO attachment (ROWID, filename, mime_type, total_bytes) VALUES (11, '/clip.mov', 'video/quicktime', 9999999)").run();
  db.prepare("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 10)").run();
  db.prepare("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 11)").run();

  const [row] = readMessagesSince(db, 0);
  assert.equal(row.attachments.length, 2);
  assert.deepEqual(row.attachments[0], { filename: '/img1.jpg', mime_type: 'image/jpeg', size_bytes: 12345, uti: 'public.jpeg' });
  assert.equal(row.attachments[1].mime_type, 'video/quicktime');
  db.close();
});

test('readMessagesSince filters by ROWID cursor', () => {
  const db = makeFixtureDb();
  seedBasic(db);
  db.prepare("INSERT INTO message (ROWID, guid, text, handle_id, date) VALUES (1, 'M-1', 'a', 1, 0)").run();
  db.prepare("INSERT INTO message (ROWID, guid, text, handle_id, date) VALUES (2, 'M-2', 'b', 1, 0)").run();
  db.prepare("INSERT INTO message (ROWID, guid, text, handle_id, date) VALUES (3, 'M-3', 'c', 1, 0)").run();
  db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1), (1, 2), (1, 3)").run();
  const rows = readMessagesSince(db, 1);
  assert.deepEqual(rows.map((r) => r.rowid), [2, 3]);
  db.close();
});

test('pollOnce skips is_from_me=1 and writes cursor', async () => {
  const db = makeFixtureDb();
  seedBasic(db);
  db.prepare("INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me) VALUES (1, 'M-1', 'inbound', 2, 0, 0)").run();
  db.prepare("INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me) VALUES (2, 'M-2', 'I sent this', 2, 0, 1)").run();
  db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1), (1, 2)").run();

  let cursor = 0;
  const events = [];
  const r = await pollOnce({
    db,
    allowlist: { directHandles: new Set(['dad@x.com']), groupChats: new Set() },
    recordEvent: async (e) => events.push(e),
    getCursor: async () => cursor,
    setCursor: async (v) => { cursor = v; },
    logger: { warn: () => {} },
  });

  assert.equal(r.polled, 2);
  assert.equal(r.allowed, 1);
  assert.equal(r.skipped_self, 1);
  assert.equal(r.new_cursor, 2);
  assert.equal(cursor, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'imessage');
  assert.equal(events[0].content, 'inbound');
  assert.equal(events[0].meta.chat_guid, 'CHAT-DM-1');
  db.close();
});

test('pollOnce filters by allowlist', async () => {
  const db = makeFixtureDb();
  seedBasic(db);
  // From dad (allowed) and from a non-allowed handle.
  db.prepare("INSERT INTO message (ROWID, guid, text, handle_id, date) VALUES (1, 'A', 'from dad', 2, 0)").run();
  db.prepare("INSERT INTO message (ROWID, guid, text, handle_id, date) VALUES (2, 'B', 'from stranger', 1, 0)").run();
  db.prepare("INSERT INTO chat_message_join VALUES (1, 1), (1, 2)").run();

  const events = [];
  const r = await pollOnce({
    db,
    allowlist: { directHandles: new Set(['dad@x.com']), groupChats: new Set() },
    recordEvent: async (e) => events.push(e),
    getCursor: async () => 0,
    setCursor: async () => {},
  });

  assert.equal(r.allowed, 1);
  assert.equal(r.skipped_allowlist, 1);
  assert.equal(events[0].meta.handle, 'dad@x.com');
  db.close();
});

test('pollOnce allows group chats by chat_guid', async () => {
  const db = makeFixtureDb();
  seedBasic(db);
  db.prepare("INSERT INTO message (ROWID, guid, text, handle_id, date) VALUES (1, 'G-1', 'group ping', 1, 0)").run();
  db.prepare("INSERT INTO chat_message_join VALUES (2, 1)").run(); // chat 2 = group

  const events = [];
  const r = await pollOnce({
    db,
    allowlist: { directHandles: new Set(), groupChats: new Set(['CHAT-GROUP-1']) },
    recordEvent: async (e) => events.push(e),
    getCursor: async () => 0,
    setCursor: async () => {},
  });
  assert.equal(r.allowed, 1);
  assert.equal(events[0].meta.chat_is_group, true);
  assert.equal(events[0].meta.chat_display_name, 'Family');
  db.close();
});

test('pollOnce surfaces reactions as [reaction:N] prefix', async () => {
  const db = makeFixtureDb();
  seedBasic(db);
  db.prepare("INSERT INTO message (ROWID, guid, text, handle_id, date, associated_message_type) VALUES (1, 'R-1', 'liked', 2, 0, 2000)").run();
  db.prepare("INSERT INTO chat_message_join VALUES (1, 1)").run();

  const events = [];
  await pollOnce({
    db,
    allowlist: { directHandles: new Set(['dad@x.com']), groupChats: new Set() },
    recordEvent: async (e) => events.push(e),
    getCursor: async () => 0,
    setCursor: async () => {},
  });
  assert.match(events[0].content, /\[reaction:2000\]/);
  db.close();
});

test('pollOnce empty when no new rows', async () => {
  const db = makeFixtureDb();
  seedBasic(db);
  const r = await pollOnce({
    db,
    allowlist: { directHandles: new Set(), groupChats: new Set() },
    recordEvent: async () => {},
    getCursor: async () => 5000,
    setCursor: async () => {},
  });
  assert.deepEqual(r, { polled: 0, allowed: 0, skipped_self: 0, skipped_allowlist: 0, new_cursor: 5000 });
  db.close();
});
