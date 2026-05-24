import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { captureSession } from './capture.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cap-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('capture: skips session with no assistant turn', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 's1',
    turns: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'no_assistant_turn');
  closeDb(db);
});

test('capture: skips single-word ack', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'great' },
    ],
  });
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'single_word_ack');
  closeDb(db);
});

test('capture: captures meaningful session and writes event', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      { role: 'user', content: 'tell me about Kevin' },
      { role: 'assistant', content: 'Kevin is a product engineer based in NJ.' },
    ],
  });
  assert.equal(r.captured, true);
  assert.ok(r.eventId);
  const row = db.prepare("SELECT * FROM events WHERE kind='session.captured'").get() as {
    kind: string;
    payload: string;
  };
  assert.equal(row.kind, 'session.captured');
  const payload = JSON.parse(row.payload);
  assert.equal(payload.sessionId, 's1');
  closeDb(db);
});

test('capture: dedup_hit prevents identical capture', async () => {
  const db = freshDb();
  const capture = {
    sessionId: 's1',
    turns: [
      { role: 'user' as const, content: 'tell me about photo-tools' },
      { role: 'assistant' as const, content: 'Photo-tools is a Next.js photography toolkit.' },
    ],
  };
  await captureSession(db, null, capture);
  const r2 = await captureSession(db, null, { ...capture, sessionId: 's2' });
  assert.equal(r2.captured, false);
  assert.equal(r2.skipReason, 'dedup_hit');
  closeDb(db);
});

// ─── cwd allowlist ("robin only works in robin's folder" scoping) ────

const validCapture = {
  sessionId: 's-cwd',
  turns: [
    { role: 'user' as const, content: 'hello robin' },
    { role: 'assistant' as const, content: 'hi! how can I help?' },
  ],
};

test('capture: rejects cwd outside the allowlist', async () => {
  const db = freshDb();
  const r = await captureSession(
    db,
    null,
    { ...validCapture, cwd: '/home/dev/workspace/photo-tools' },
    { allowedCwds: ['/home/dev/workspace/robin/robin-assistant'] },
  );
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'cwd_not_allowed');
  closeDb(db);
});

test('capture: accepts cwd that exactly matches an allowlist entry', async () => {
  const db = freshDb();
  const r = await captureSession(
    db,
    null,
    { ...validCapture, cwd: '/home/dev/workspace/robin/robin-assistant' },
    { allowedCwds: ['/home/dev/workspace/robin/robin-assistant'] },
  );
  assert.equal(r.captured, true);
  closeDb(db);
});

test('capture: accepts cwd that is a descendant of an allowlist entry', async () => {
  const db = freshDb();
  const r = await captureSession(
    db,
    null,
    {
      ...validCapture,
      cwd: '/home/dev/workspace/robin/robin-assistant/user-data/scripts',
    },
    { allowedCwds: ['/home/dev/workspace/robin/robin-assistant'] },
  );
  assert.equal(r.captured, true);
  closeDb(db);
});

test('capture: rejects sibling path that prefixes share a parent (no slash boundary)', async () => {
  // Defends against `/home/dev/workspace/robin/robin-assistant-fork` being
  // matched as a descendant of `/home/dev/workspace/robin/robin-assistant`.
  const db = freshDb();
  const r = await captureSession(
    db,
    null,
    { ...validCapture, cwd: '/home/dev/workspace/robin/robin-assistant-fork' },
    { allowedCwds: ['/home/dev/workspace/robin/robin-assistant'] },
  );
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'cwd_not_allowed');
  closeDb(db);
});

test('capture: skips the check when cwd is undefined (programmatic callers)', async () => {
  const db = freshDb();
  const r = await captureSession(
    db,
    null,
    validCapture, // no cwd field
    { allowedCwds: ['/some/strict/allowlist'] },
  );
  assert.equal(r.captured, true, 'undefined cwd should bypass the allowlist check');
  closeDb(db);
});

test('capture: empty allowlist is fail-open (default could not resolve)', async () => {
  const db = freshDb();
  const r = await captureSession(
    db,
    null,
    { ...validCapture, cwd: '/anywhere' },
    { allowedCwds: [] },
  );
  assert.equal(r.captured, true, 'empty allowlist should not reject');
  closeDb(db);
});
