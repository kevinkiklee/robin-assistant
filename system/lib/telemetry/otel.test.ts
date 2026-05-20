import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { openDb, closeDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { exportRecentEventsAsOtel } from './otel.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-otel-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

async function startCollector(): Promise<{
  url: string;
  received: { body: unknown }[];
  server: Server;
}> {
  const received: { body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      received.push({ body: JSON.parse(raw) });
    } catch {
      received.push({ body: raw });
    }
    res.statusCode = 200;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}/v1/traces`, received, server };
}

test('otel: no-op when endpoint missing', async () => {
  const db = freshDb();
  const r = await exportRecentEventsAsOtel(db, {});
  assert.equal(r.sent, 0);
  closeDb(db);
});

test('otel: exports recent events to mock collector', async () => {
  const db = freshDb();
  db.prepare(
    'INSERT INTO events (ts, kind, source, status, payload, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(new Date().toISOString(), 'test.event', 't', 'ok', '{}', 42);
  db.prepare(
    'INSERT INTO events (ts, kind, source, status, payload, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(new Date().toISOString(), 'test.event', 't', 'error', '{}', 100);
  const collector = await startCollector();
  try {
    const r = await exportRecentEventsAsOtel(db, {
      endpoint: collector.url,
      serviceName: 'robin-test',
    });
    assert.equal(r.sent, 2);
    assert.equal(collector.received.length, 1);
    const body = collector.received[0]
      .body as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; status: { code: number } }> }> }>;
    };
    const spans = body.resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans.length, 2);
    assert.ok(spans.some((s) => s.status.code === 2)); // the errored one
  } finally {
    collector.server.close();
  }
  closeDb(db);
});

test('otel: graceful failure on non-OK collector response', async () => {
  const db = freshDb();
  db.prepare(
    'INSERT INTO events (ts, kind, source, status, payload) VALUES (?, ?, ?, ?, ?)',
  ).run(new Date().toISOString(), 't', 't', 'ok', '{}');
  const server = createServer((_req, res) => {
    res.statusCode = 500;
    res.end('busted');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const r = await exportRecentEventsAsOtel(db, {
    endpoint: `http://127.0.0.1:${port}/v1/traces`,
  });
  assert.equal(r.sent, 0);
  assert.match(r.error ?? '', /500/);
  server.close();
  closeDb(db);
});
