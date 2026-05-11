// Integration tests for the in-daemon DB browser handler.
// Drives the handler directly with mocked req/res — same surface the daemon
// uses, no HTTP socket round-trip needed.

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { recordEvent } from '../../src/capture/record-event.js';
import { createBrowserHandler } from '../../src/db/browse/server.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

function mockReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const listeners = {};
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:9999', ...headers },
    on(evt, cb) {
      listeners[evt] = cb;
      return req;
    },
  };
  if (body != null) {
    setImmediate(() => {
      listeners.data?.(Buffer.from(body));
      listeners.end?.();
    });
  } else {
    setImmediate(() => listeners.end?.());
  }
  return req;
}

function mockRes() {
  let status = null;
  let headers = null;
  let body = '';
  const res = {
    setHeader: () => {},
    writeHead(s, h) {
      status = s;
      headers = h;
    },
    end(payload) {
      body = payload ?? '';
    },
  };
  res.req = null;
  return {
    res,
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    get body() {
      return body;
    },
    json() {
      return JSON.parse(body);
    },
  };
}

async function call(handler, { method, url, headers, body } = {}) {
  const req = mockReq({ method, url, headers, body });
  const r = mockRes();
  r.res.req = req;
  const handled = await handler(req, r.res);
  return { handled, ...r };
}

async function setupDb() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('handler ignores paths outside /db/', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, { url: '/internal/foo' });
  assert.equal(r.handled, false);
  await close(db);
});

test('GET /db/ returns HTML', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, { url: '/db/' });
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  assert.match(r.headers['Content-Type'], /text\/html/);
  assert.match(r.body, /<html/i);
  await close(db);
});

test('GET /db/api/info returns table list with counts', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, { url: '/db/api/info' });
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  const data = r.json();
  assert.ok(Array.isArray(data.tables), 'tables array present');
  assert.ok(data.tables.includes('events'), 'events table listed');
  assert.ok(data.tables.includes('entities'), 'entities table listed');
  assert.ok(data.tables.includes('knowledge'), 'knowledge table listed');
  assert.equal(typeof data.counts, 'object');
  assert.equal(data.layers.events, 'L1');
  assert.equal(data.layers.entities, 'L3');
  await close(db);
});

test('GET /db/api/architecture returns v2 layer structure', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, { url: '/db/api/architecture' });
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  const data = r.json();
  assert.match(data.title, /four layers/);
  const layerIds = data.layers.map((l) => l.id);
  assert.deepEqual(layerIds, ['L1', 'L2', 'L3', 'L4', 'OP']);
  await close(db);
});

test('GET /db/api/table/events returns schema + count', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, { url: '/db/api/table/events' });
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  const data = r.json();
  assert.equal(data.name, 'events');
  assert.ok(data.meta, 'meta from TABLE_INFO');
  assert.equal(data.meta.layer, 'L1');
  assert.ok(Array.isArray(data.schema.fields));
  await close(db);
});

test('POST /db/api/query runs SurrealQL and returns responses', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, {
    method: 'POST',
    url: '/db/api/query',
    headers: { origin: 'http://127.0.0.1:9999' },
    body: JSON.stringify({ sql: 'SELECT count() AS n FROM events GROUP ALL;' }),
  });
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  const data = r.json();
  assert.ok(Array.isArray(data.responses));
  assert.equal(data.responses[0].success, true);
  await close(db);
});

test('POST /db/api/query rejects missing sql', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, {
    method: 'POST',
    url: '/db/api/query',
    headers: { origin: 'http://127.0.0.1:9999' },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
  await close(db);
});

test('rejects requests with bad Host header (DNS rebind defence)', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, {
    url: '/db/api/info',
    headers: { host: 'evil.example.com' },
  });
  assert.equal(r.status, 403);
  await close(db);
});

test('rejects POST with cross-origin Origin', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, {
    method: 'POST',
    url: '/db/api/query',
    headers: { origin: 'http://evil.example.com' },
    body: JSON.stringify({ sql: 'SELECT 1' }),
  });
  assert.equal(r.status, 403);
  await close(db);
});

test('GET /db/api/view/dashboard returns v2-shaped payload', async () => {
  const db = await setupDb();
  // Seed at least one event so the dashboard has data to summarise.
  const embedder = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, embedder, { source: 'cli', content: 'first event' });
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, { url: '/db/api/view/dashboard' });
  assert.equal(r.status, 200);
  const data = r.json();
  assert.ok(data.counts, 'counts present');
  assert.ok(Array.isArray(data.recent_activity));
  assert.ok(typeof data.ms === 'number');
  assert.ok('pending_rules' in data.needs_input);
  await close(db);
});

test('GET /db/api/view/search?q= returns entity matches', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, { url: '/db/api/view/search?q=alice' });
  assert.equal(r.status, 200);
  const data = r.json();
  assert.ok(Array.isArray(data.results));
  await close(db);
});

test('GET /db/api/view/analysis/<card> returns shape per card', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r1 = await call(handler, { url: '/db/api/view/analysis/top-entities' });
  assert.equal(r1.status, 200);
  assert.ok('entities' in r1.json());

  const r2 = await call(handler, { url: '/db/api/view/analysis/knowledge-by-topic' });
  assert.equal(r2.status, 200);
  assert.ok(Array.isArray(r2.json().rows));

  const r3 = await call(handler, { url: '/db/api/view/analysis/unknown-card' });
  assert.equal(r3.status, 404);
  await close(db);
});

test('GET /db/api/view/trends?metric=activity-pulse returns series', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, { url: '/db/api/view/trends?metric=activity-pulse&range=30d' });
  assert.equal(r.status, 200);
  const data = r.json();
  assert.equal(data.metric, 'activity-pulse');
  assert.ok(Array.isArray(data.series));
  await close(db);
});

test('GET /db/static/<name> serves a known module', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, { url: '/db/static/browse-utils.js' });
  assert.equal(r.status, 200);
  assert.match(r.headers['Content-Type'], /application\/javascript/);
  assert.match(r.body, /export function compactFieldDef/);
  await close(db);
});

test('GET /db/static/<unknown> returns 404', async () => {
  const db = await setupDb();
  const handler = createBrowserHandler({ db, expectedPort: 9999 });
  const r = await call(handler, { url: '/db/static/no-such-module.js' });
  assert.equal(r.status, 404);
  await close(db);
});
