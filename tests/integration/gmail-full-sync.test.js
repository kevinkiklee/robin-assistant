import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mock, test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import { sync } from '../../src/integrations/gmail/sync.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

function fakeMsg(id, labels = ['INBOX']) {
  return {
    id,
    threadId: `t-${id}`,
    snippet: `body ${id}`,
    labelIds: labels,
    internalDate: String(Date.now()),
    payload: {
      headers: [
        { name: 'Subject', value: `Subj ${id}` },
        { name: 'From', value: 'a@b.c' },
      ],
    },
  };
}

test('gmail full-sync writes events with correct external_ids and skips SPAM', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'gmail',
    embed: true,
    mode: 'insert-or-skip',
  });

  const fetchFn = mock.fn(async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'a-fresh', expires_in: 3600 }),
      };
    }
    if (url.includes('/profile')) {
      return { ok: true, status: 200, json: async () => ({ historyId: 'h-100' }) };
    }
    if (url.includes('/messages?')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
        }),
      };
    }
    if (url.includes('/messages/m1')) {
      return { ok: true, status: 200, json: async () => fakeMsg('m1') };
    }
    if (url.includes('/messages/m2')) {
      return { ok: true, status: 200, json: async () => fakeMsg('m2', ['SPAM']) };
    }
    if (url.includes('/messages/m3')) {
      return { ok: true, status: 200, json: async () => fakeMsg('m3') };
    }
    throw new Error(`unexpected: ${url}`);
  });

  const ctx = {
    secrets: {
      GOOGLE_OAUTH_CLIENT_ID: 'c',
      GOOGLE_OAUTH_CLIENT_SECRET: 's',
      GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
    },
    log: () => {},
    cursor: null,
    capture,
    fetchFn,
  };
  const r = await sync(ctx);

  assert.equal(r.count, 2);
  const [rows] = await db
    .query(surql`SELECT external_id, source FROM events ORDER BY external_id`)
    .collect();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].external_id, 'm1');
  assert.equal(rows[1].external_id, 'm3');
  assert.equal(rows[0].source, 'gmail');
  await close(db);
});
