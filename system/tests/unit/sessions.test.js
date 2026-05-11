import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import {
  endSession,
  listActiveSessions,
  markStaleSessions,
  purgeStaleSessions,
  registerSession,
} from '../../runtime/daemon/sessions.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { writeConfig } from '../../config/paths.js';

// __robin_test_home_setup__
const __robinTestHome = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('registerSession creates a row with active status', async () => {
  const db = await fresh();
  const row = await registerSession(db, {
    sessionId: 's-alpha',
    host: 'claude-code',
    pid: 12345,
    transcriptPath: '/tmp/t-alpha.jsonl',
  });
  assert.equal(row.session_id, 's-alpha');
  assert.equal(row.host, 'claude-code');
  assert.equal(row.pid, 12345);
  assert.equal(row.transcript_path, '/tmp/t-alpha.jsonl');
  assert.equal(row.status, 'active');

  const [rows] = await db
    .query(surql`SELECT count() AS n FROM runtime_sessions GROUP ALL`)
    .collect();
  assert.equal(rows[0].n, 1);
  await close(db);
});

test('registering the same session twice updates last_seen_at without duplicating', async () => {
  const db = await fresh();
  const first = await registerSession(db, {
    sessionId: 's-beta',
    host: 'claude-code',
    pid: 1,
  });
  const firstSeen =
    first.last_seen_at instanceof Date
      ? first.last_seen_at.getTime()
      : new Date(first.last_seen_at).getTime();

  // Sleep a few ms so last_seen_at advances measurably.
  await new Promise((r) => setTimeout(r, 25));

  const second = await registerSession(db, {
    sessionId: 's-beta',
    host: 'claude-code',
    pid: 1,
    transcriptPath: '/tmp/t-beta.jsonl',
  });
  const secondSeen =
    second.last_seen_at instanceof Date
      ? second.last_seen_at.getTime()
      : new Date(second.last_seen_at).getTime();
  assert.ok(secondSeen >= firstSeen, 'last_seen_at should be bumped (>=)');
  assert.equal(second.transcript_path, '/tmp/t-beta.jsonl');

  const [count] = await db
    .query(surql`SELECT count() AS n FROM runtime_sessions GROUP ALL`)
    .collect();
  assert.equal(count[0].n, 1);
  await close(db);
});

test('endSession marks status=ended', async () => {
  const db = await fresh();
  await registerSession(db, { sessionId: 's-gamma', host: 'claude-code' });
  await endSession(db, 's-gamma');
  const [rows] = await db
    .query(surql`SELECT status FROM runtime_sessions WHERE session_id = 's-gamma'`)
    .collect();
  assert.equal(rows[0].status, 'ended');
  await close(db);
});

test('endSession is a no-op for unknown session_id', async () => {
  const db = await fresh();
  const r = await endSession(db, 'does-not-exist');
  assert.equal(r, null);
  await close(db);
});

test('markStaleSessions only flips active rows older than threshold', async () => {
  const db = await fresh();
  await registerSession(db, { sessionId: 's-fresh', host: 'claude-code' });
  await registerSession(db, { sessionId: 's-old', host: 'claude-code' });
  await registerSession(db, { sessionId: 's-ended', host: 'claude-code' });
  await endSession(db, 's-ended');

  // Force one session into the past by direct UPDATE.
  const past = new Date(Date.now() - 10 * 60_000).toISOString();
  await db
    .query(
      surql`UPDATE runtime_sessions SET last_seen_at = type::datetime(${past}) WHERE session_id = 's-old'`,
    )
    .collect();

  const n = await markStaleSessions(db, { staleMs: 5 * 60_000 });
  assert.equal(n, 1);
  const [rows] = await db
    .query(surql`SELECT session_id, status FROM runtime_sessions ORDER BY session_id`)
    .collect();
  const byId = Object.fromEntries(rows.map((r) => [r.session_id, r.status]));
  assert.equal(byId['s-old'], 'stale');
  assert.equal(byId['s-fresh'], 'active');
  assert.equal(byId['s-ended'], 'ended');
  await close(db);
});

test('listActiveSessions returns only active rows ordered by started_at', async () => {
  const db = await fresh();
  await registerSession(db, { sessionId: 's-1', host: 'claude-code' });
  await registerSession(db, { sessionId: 's-2', host: 'claude-code' });
  await registerSession(db, { sessionId: 's-3', host: 'claude-code' });
  await endSession(db, 's-2');

  const active = await listActiveSessions(db);
  const ids = active.map((r) => r.session_id);
  assert.deepEqual(ids.sort(), ['s-1', 's-3']);
  for (const r of active) assert.equal(r.status, 'active');
  await close(db);
});

test('purgeStaleSessions deletes only stale rows and returns count', async () => {
  const db = await fresh();
  await registerSession(db, { sessionId: 's-active', host: 'claude-code' });
  await registerSession(db, { sessionId: 's-stale-1', host: 'claude-code' });
  await registerSession(db, { sessionId: 's-stale-2', host: 'claude-code' });
  await registerSession(db, { sessionId: 's-ended', host: 'claude-code' });

  // Mark two as stale by aging them.
  const past = new Date(Date.now() - 10 * 60_000).toISOString();
  await db
    .query(
      surql`UPDATE runtime_sessions SET last_seen_at = type::datetime(${past}) WHERE session_id IN ['s-stale-1','s-stale-2']`,
    )
    .collect();
  await markStaleSessions(db);
  await endSession(db, 's-ended');

  const n = await purgeStaleSessions(db);
  assert.equal(n, 2);

  const [rows] = await db
    .query(surql`SELECT session_id FROM runtime_sessions ORDER BY session_id`)
    .collect();
  const ids = rows.map((r) => r.session_id);
  assert.deepEqual(ids.sort(), ['s-active', 's-ended']);
  await close(db);
});
