import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { VALID_SOURCES } from '../../io/capture/record-event.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

// ---------------------------------------------------------------------------
// Group 1: VALID_SOURCES contains new self-improvement-v2 entries
// ---------------------------------------------------------------------------

const NEW_SOURCES = [
  'explicit_correction',
  'task_outcome',
  'playbook_proposed',
  'playbook_applied',
  'introspection_sample',
  'confidence_resolved',
];

const PRIOR_SOURCES = [
  'cli',
  'stop_hook',
  'manual',
  'sync',
  'biographer',
  'ingest',
  'discord',
  'migration',
  'conversation',
  'agent_internal',
];

for (const src of NEW_SOURCES) {
  test(`VALID_SOURCES contains new source: ${src}`, () => {
    assert.ok(VALID_SOURCES.has(src), `expected VALID_SOURCES to contain "${src}"`);
  });
}

for (const src of PRIOR_SOURCES) {
  test(`VALID_SOURCES still contains prior source: ${src}`, () => {
    assert.ok(VALID_SOURCES.has(src), `expected VALID_SOURCES to still contain "${src}"`);
  });
}

// ---------------------------------------------------------------------------
// Group 2: task_close_queue table accepts spec shape
// ---------------------------------------------------------------------------

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('task_close_queue table accepts spec shape INSERT and SELECT', async () => {
  const db = await fresh();

  // First create an event row so the record<events> FK resolves.
  const [eventRows] = await db
    .query(surql`CREATE events SET source = 'agent_internal', content = 'test', content_hash = 'abc'`)
    .collect();
  const eventRow = Array.isArray(eventRows) ? eventRows[0] : eventRows;
  assert.ok(eventRow?.id, 'event created for FK');

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000);

  const [inserted] = await db
    .query(
      surql`CREATE task_close_queue SET
        task_type   = ${'linear_issue'},
        task_id     = ${'LIN-42'},
        event_id    = ${eventRow.id},
        payload     = ${{ score: 1 }},
        enqueued_at = ${now},
        claimed_at  = NONE,
        claimed_by  = NONE,
        expires_at  = ${expiresAt}`,
    )
    .collect();
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  assert.ok(row?.id, 'task_close_queue row created');

  const [selected] = await db
    .query(surql`SELECT * FROM ONLY ${row.id}`)
    .collect();
  const r = Array.isArray(selected) ? selected[0] : selected;

  assert.equal(r.task_type, 'linear_issue');
  assert.equal(r.task_id, 'LIN-42');
  assert.equal(String(r.event_id), String(eventRow.id));
  assert.deepEqual(r.payload, { score: 1 });
  // SurrealDB v3 returns datetimes as its own `DateTime` class, not a plain JS
  // Date — check that the field is a non-null object with a string representation.
  assert.ok(r.enqueued_at != null && typeof r.enqueued_at === 'object', 'enqueued_at is a datetime object');
  assert.ok(r.expires_at != null && typeof r.expires_at === 'object', 'expires_at is a datetime object');
  // SurrealDB NONE / option fields come back as undefined in the JS client.
  assert.ok(r.claimed_at == null, 'claimed_at is null/undefined (option<datetime>)');
  assert.ok(r.claimed_by == null, 'claimed_by is null/undefined (option<string>)');

  await close(db);
});
