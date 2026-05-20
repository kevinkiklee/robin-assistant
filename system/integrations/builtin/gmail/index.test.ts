import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildContext } from '../../_runtime/context.ts';
import { actions, integration as gmail } from './index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-gmail-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function setEnv() {
  process.env.GMAIL_REFRESH_TOKEN = 'fake-refresh';
  process.env.GMAIL_CLIENT_ID = 'cid';
  process.env.GMAIL_CLIENT_SECRET = 'csec';
}

function clearEnv() {
  delete process.env.GMAIL_REFRESH_TOKEN;
  delete process.env.GMAIL_CLIENT_ID;
  delete process.env.GMAIL_CLIENT_SECRET;
}

test('gmail: tick skips when secrets missing', async () => {
  const db = freshDb();
  const ctx = buildContext('gmail', db, null);
  clearEnv();
  const r = await gmail.tick!(ctx);
  assert.equal(r.status, 'skipped');
  closeDb(db);
});

test('gmail: tick fetches and ingests unread messages', async () => {
  const db = freshDb();
  const ctx = buildContext('gmail', db, null);
  setEnv();
  ctx.fetch = (async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
      });
    }
    if (url.includes('/messages?q=')) {
      return new Response(
        JSON.stringify({
          messages: [
            { id: 'm1', threadId: 't1' },
            { id: 'm2', threadId: 't1' },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes('/messages/m1')) {
      return new Response(
        JSON.stringify({
          id: 'm1',
          threadId: 't1',
          snippet: 'hello there',
          payload: {
            headers: [
              { name: 'From', value: 'sarah@example.com' },
              { name: 'Subject', value: 'Lunch?' },
            ],
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/messages/m2')) {
      return new Response(
        JSON.stringify({
          id: 'm2',
          threadId: 't1',
          snippet: 'follow up',
          payload: {
            headers: [
              { name: 'From', value: 'sarah@example.com' },
              { name: 'Subject', value: 'Re: Lunch?' },
            ],
          },
        }),
        { status: 200 },
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const r = await gmail.tick!(ctx);
  assert.equal(r.status, 'ok');
  assert.equal(r.ingested, 2);
  const rows = db.prepare("SELECT body FROM events_content WHERE body LIKE '%Lunch%'").all();
  assert.equal(rows.length, 2);
  clearEnv();
  closeDb(db);
});

test('gmail: health is unhealthy without secrets', async () => {
  const db = freshDb();
  const ctx = buildContext('gmail', db, null);
  clearEnv();
  const h = await gmail.health!(ctx);
  assert.equal(h.ok, false);
  closeDb(db);
});

test('gmail: actions.search returns message list items', async () => {
  const db = freshDb();
  const ctx = buildContext('gmail', db, null);
  setEnv();
  ctx.fetch = (async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ messages: [{ id: 'a', threadId: 't' }] }), {
      status: 200,
    });
  }) as typeof fetch;
  const r = await actions.search({ q: 'from:sarah' }, ctx);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'a');
  clearEnv();
  closeDb(db);
});
