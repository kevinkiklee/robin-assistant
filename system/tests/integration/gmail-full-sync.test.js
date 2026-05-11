import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { _resetCache } from '../../io/integrations/_auth/token-cache.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';
import { sync } from '../../io/integrations/gmail/sync.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
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
  _resetCache('google');
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
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
    .query(surql`SELECT meta.external_id AS external_id, source FROM events ORDER BY external_id`)
    .collect();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].external_id, 'm1');
  assert.equal(rows[1].external_id, 'm3');
  assert.equal(rows[0].source, 'gmail');
  await close(db);
});
