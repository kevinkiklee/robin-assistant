// Integration tests for the doctor `pending_recall_log` probe.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { rollupPendingRecallLog, runHealth } from '../../runtime/cli/health.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  const dir = resolve(import.meta.dirname, '../../data/db/migrations');
  await runMigrations(db, dir);
  return db;
}

test('rollupPendingRecallLog: 0 pending → ok', async () => {
  const db = await fresh();
  const r = await rollupPendingRecallLog(db);
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 0);
  await close(db);
});

test('rollupPendingRecallLog: 50 pending older than 7d → ok (below threshold)', async () => {
  const db = await fresh();
  const old = new Date(Date.now() - 8 * 86_400_000);
  for (let i = 0; i < 50; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
          ts: ${old}, query: ${`q${i}`}, k: 6, ranked_hits: [],
          outcome: 'pending', session_id: ${`s${i}`}, meta: {}
        }`,
      )
      .collect();
  }
  const r = await rollupPendingRecallLog(db);
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 50);
  await close(db);
});

test('rollupPendingRecallLog: 101 pending older than 7d → warn', async () => {
  const db = await fresh();
  const old = new Date(Date.now() - 8 * 86_400_000);
  for (let i = 0; i < 101; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
          ts: ${old}, query: ${`q${i}`}, k: 6, ranked_hits: [],
          outcome: 'pending', session_id: ${`s${i}`}, meta: {}
        }`,
      )
      .collect();
  }
  const r = await rollupPendingRecallLog(db);
  assert.equal(r.status, 'warn');
  assert.equal(r.count, 101);
  await close(db);
});

test('rollupPendingRecallLog: pending rows within 7d are NOT counted', async () => {
  const db = await fresh();
  const recent = new Date(Date.now() - 3 * 86_400_000);
  for (let i = 0; i < 5; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
          ts: ${recent}, query: ${`q${i}`}, k: 6, ranked_hits: [],
          outcome: 'pending', session_id: ${`s${i}`}, meta: {}
        }`,
      )
      .collect();
  }
  const r = await rollupPendingRecallLog(db);
  assert.equal(r.count, 0); // recent pending rows excluded
  await close(db);
});

test('runHealth includes pending_recall_log in JSON output and exit code', async () => {
  const db = await fresh();
  const old = new Date(Date.now() - 8 * 86_400_000);
  for (let i = 0; i < 101; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
          ts: ${old}, query: ${`q${i}`}, k: 6, ranked_hits: [],
          outcome: 'pending', session_id: ${`s${i}`}, meta: {}
        }`,
      )
      .collect();
  }
  const r = await runHealth(db, { json: true });
  const parsed = JSON.parse(r.output);
  assert.equal(parsed.pending_recall_log.status, 'warn');
  // Exit code should reflect a warn level.
  assert.ok(r.exitCode >= 1);
  await close(db);
});

test('runHealth text output includes the pending_recall_log line', async () => {
  const db = await fresh();
  const r = await runHealth(db);
  assert.match(r.output, /Pending recall_log >7d:/);
  await close(db);
});
