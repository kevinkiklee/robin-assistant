import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { startHttpServer } from './server.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-http-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('http: GET /health returns 200 with ok=true when healthy', async () => {
  const db = freshDb();
  const h = await startHttpServer({ db, port: 0, isHealthy: () => true });
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://${h.host}:${h.port}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, true);
  } finally {
    await h.close();
    closeDb(db);
  }
});

test('http: GET /health returns 503 when unhealthy', async () => {
  const db = freshDb();
  const h = await startHttpServer({ db, port: 0, isHealthy: () => false });
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://${h.host}:${h.port}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    assert.equal(res.status, 503);
  } finally {
    await h.close();
    closeDb(db);
  }
});

test('http: POST /hooks/<kind> dispatches to onHook with parsed payload', async () => {
  const db = freshDb();
  const captured: { kind: string; payload: unknown } = { kind: '', payload: {} };
  const h = await startHttpServer({
    db,
    port: 0,
    isHealthy: () => true,
    onHook: async (kind, payload) => {
      captured.kind = kind;
      captured.payload = payload;
    },
  });
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://${h.host}:${h.port}/hooks/session_end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc', turns: 3 }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    assert.equal(res.status, 200);
    assert.equal(captured.kind, 'session_end');
    assert.deepEqual(captured.payload, { session_id: 'abc', turns: 3 });
  } finally {
    await h.close();
    closeDb(db);
  }
});

test('http: unknown path returns 404', async () => {
  const db = freshDb();
  const h = await startHttpServer({ db, port: 0, isHealthy: () => true });
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://${h.host}:${h.port}/nope`, { signal: controller.signal });
    clearTimeout(timeoutId);
    assert.equal(res.status, 404);
  } finally {
    await h.close();
    closeDb(db);
  }
});
