import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { __test__, makeWebServer } from '../../runtime/web/server.js';

const { isHostAllowed } = __test__;

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function listenEphemeral(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test('isHostAllowed accepts loopback', () => {
  assert.equal(isHostAllowed('127.0.0.1:18791', 18791), true);
  assert.equal(isHostAllowed('localhost:18791', 18791), true);
  assert.equal(isHostAllowed('[::1]:18791', 18791), true);
});

test('isHostAllowed rejects non-loopback and wrong port', () => {
  assert.equal(isHostAllowed('evil.com:18791', 18791), false);
  assert.equal(isHostAllowed('127.0.0.1:9999', 18791), false);
  assert.equal(isHostAllowed('', 18791), false);
});

test('GET /api/info returns tables + counts', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    const r = await fetch(`${base}/api/info`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.ok(Array.isArray(data.tables));
    assert.ok(data.tables.includes('events'));
    assert.equal(typeof data.counts, 'object');
  } finally {
    server.close();
    await close(db);
  }
});

test('GET / serves index.html', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const body = await r.text();
    assert.ok(body.includes('robin'));
    assert.ok(body.includes('app.css'));
  } finally {
    server.close();
    await close(db);
  }
});

test('POST /api/query runs SQL when writes allowed', async () => {
  const db = await fresh();
  const server = makeWebServer({ db, allowWrites: true, requireCsrf: false });
  const base = await listenEphemeral(server);
  try {
    await db.query("CREATE events SET source = 'whoop', content = 'hello'").collect();
    const r = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT count() AS n FROM events GROUP ALL' }),
    });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.responses[0].success, true);
    assert.equal(data.responses[0].result[0].n, 1);
  } finally {
    server.close();
    await close(db);
  }
});

test('POST /api/query refused when writes disabled', async () => {
  const db = await fresh();
  const server = makeWebServer({ db, allowWrites: false, requireCsrf: false });
  const base = await listenEphemeral(server);
  try {
    const r = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'RETURN 1' }),
    });
    assert.equal(r.status, 403);
    const data = await r.json();
    assert.match(data.error, /writes disabled/);
  } finally {
    server.close();
    await close(db);
  }
});

test('POST without CSRF token is refused when csrf required', async () => {
  const db = await fresh();
  const server = makeWebServer({ db, allowWrites: true, requireCsrf: true });
  const base = await listenEphemeral(server);
  try {
    const r = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'RETURN 1' }),
    });
    assert.equal(r.status, 403);
  } finally {
    server.close();
    await close(db);
  }
});

test('CSRF: token issued + accepted on POST', async () => {
  const db = await fresh();
  const server = makeWebServer({ db, allowWrites: true, requireCsrf: true });
  const base = await listenEphemeral(server);
  try {
    const tr = await fetch(`${base}/api/csrf-token`, { method: 'POST' });
    assert.equal(tr.status, 200);
    const { token } = await tr.json();
    assert.ok(token);
    const r = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ sql: 'RETURN 1' }),
    });
    assert.equal(r.status, 200);
  } finally {
    server.close();
    await close(db);
  }
});

test('GET /api/table/:name validates table name', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    const ok = await fetch(`${base}/api/table/events`);
    assert.equal(ok.status, 200);
    const bad = await fetch(`${base}/api/table/oh%20no`);
    assert.equal(bad.status, 404);
  } finally {
    server.close();
    await close(db);
  }
});

test('GET /api/events returns recent events', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    await db.query("CREATE events SET source = 'gmail', content = 'a'").collect();
    await db.query("CREATE events SET source = 'whoop', content = 'b'").collect();
    const r = await fetch(`${base}/api/events?limit=10`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.rows.length, 2);
  } finally {
    server.close();
    await close(db);
  }
});

test('GET /api/triggers returns recent fires', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    const r = await fetch(`${base}/api/triggers`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.ok(Array.isArray(data.recent_fires));
  } finally {
    server.close();
    await close(db);
  }
});

test('404 for unknown routes', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    const r = await fetch(`${base}/nope`);
    assert.equal(r.status, 404);
  } finally {
    server.close();
    await close(db);
  }
});
