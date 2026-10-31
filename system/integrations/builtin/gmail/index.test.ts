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
      const q = new URL(url).searchParams.get('q') ?? '';
      if (q.includes('in:sent')) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
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
              { name: 'From', value: 'nora@example.com' },
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
              { name: 'From', value: 'nora@example.com' },
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

test('gmail: tick syncs sent mail with its own cursor and no category excludes', async () => {
  const db = freshDb();
  const ctx = buildContext('gmail', db, null);
  setEnv();
  ctx.state.set('last_sync_ts', '1754600000000');
  ctx.state.set('last_sent_sync_ts', '1754500000000');
  const queries: string[] = [];
  ctx.fetch = (async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
      });
    }
    if (url.includes('/messages?q=')) {
      const q = new URL(url).searchParams.get('q') ?? '';
      queries.push(q);
      if (q.includes('in:sent')) {
        return new Response(JSON.stringify({ messages: [{ id: 's1', threadId: 'ts1' }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }
    if (url.includes('/messages/s1')) {
      return new Response(
        JSON.stringify({
          id: 's1',
          threadId: 'ts1',
          snippet: 'sounds good…',
          payload: {
            mimeType: 'multipart/alternative',
            headers: [
              { name: 'To', value: 'theo@example.com' },
              { name: 'Subject', value: 'Re: plans' },
            ],
            parts: [
              {
                mimeType: 'text/plain',
                body: { data: Buffer.from('sounds good, see you at 7').toString('base64url') },
              },
              {
                mimeType: 'text/html',
                body: { data: Buffer.from('<p>html version</p>').toString('base64url') },
              },
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

  const sentQuery = queries.find((q) => q.includes('in:sent'));
  assert.ok(sentQuery, 'expected a second query for sent mail');
  assert.equal(sentQuery, 'in:sent after:1754500000');
  assert.ok(!sentQuery.includes('category:'), 'sent query must not carry category excludes');
  const inboxQuery = queries.find((q) => q.includes('in:inbox'));
  assert.ok(inboxQuery?.includes('after:1754600000'), 'inbox query must use its own cursor');

  const rows = db
    .prepare("SELECT payload FROM events WHERE kind = 'integration.gmail.sent'")
    .all() as Array<{ payload: string }>;
  assert.equal(rows.length, 1);
  const payload = JSON.parse(rows[0].payload);
  assert.equal(payload.id, 's1');
  assert.equal(payload.threadId, 'ts1');
  assert.equal(payload.to, 'theo@example.com');
  assert.equal(payload.subject, 'Re: plans');
  const bodies = db
    .prepare("SELECT body FROM events_content WHERE body LIKE '%sounds good, see you at 7%'")
    .all();
  assert.equal(bodies.length, 1, 'ingested content must include the message body text');

  const sentCursor = ctx.state.get('last_sent_sync_ts');
  assert.ok(sentCursor && sentCursor !== '1754500000000', 'sent cursor must advance');
  const inboxCursor = ctx.state.get('last_sync_ts');
  assert.ok(inboxCursor && inboxCursor !== '1754600000000', 'inbox cursor must advance');
  clearEnv();
  closeDb(db);
});

test('gmail: first sent sync uses newer_than:1d', async () => {
  const db = freshDb();
  const ctx = buildContext('gmail', db, null);
  setEnv();
  const queries: string[] = [];
  ctx.fetch = (async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
      });
    }
    if (url.includes('/messages?q=')) {
      queries.push(new URL(url).searchParams.get('q') ?? '');
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const r = await gmail.tick!(ctx);
  assert.equal(r.status, 'ok');
  const sentQuery = queries.find((q) => q.includes('in:sent'));
  assert.equal(sentQuery, 'in:sent newer_than:1d');
  clearEnv();
  closeDb(db);
});

test('gmail: sent-leg failure does not break inbox sync', async () => {
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
      const q = new URL(url).searchParams.get('q') ?? '';
      if (q.includes('in:sent')) {
        return new Response('boom', { status: 500 });
      }
      return new Response(JSON.stringify({ messages: [{ id: 'm1', threadId: 't1' }] }), {
        status: 200,
      });
    }
    if (url.includes('/messages/m1')) {
      return new Response(
        JSON.stringify({
          id: 'm1',
          threadId: 't1',
          snippet: 'hello there',
          payload: {
            headers: [
              { name: 'From', value: 'nora@example.com' },
              { name: 'Subject', value: 'Lunch?' },
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
  assert.equal(r.ingested, 1);
  assert.ok(ctx.state.get('last_sync_ts'), 'inbox cursor must still advance');
  assert.equal(ctx.state.get('last_sent_sync_ts'), null, 'failed sent leg must not set its cursor');
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
  const r = await actions.search({ q: 'from:nora' }, ctx);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'a');
  clearEnv();
  closeDb(db);
});
