import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { dreamStepCompaction } from '../../cognition/dream/step-compaction.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

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

test('dedup query parses without arithmetic-in-ORDER-BY error', async () => {
  // Regression: SurrealQL v3 rejects `ORDER BY (a * b)` without an alias.
  // Two memos with the same content_hash trigger the dedup path; if the
  // canonical-pick query fails to parse, errors are silently logged and
  // dedup_merged stays 0. We assert dedup actually ran.
  const db = await fresh();
  try {
    const hash = 'shared-hash-for-test';
    for (let i = 0; i < 2; i++) {
      await db
        .query(
          surql`CREATE memos CONTENT ${{
            kind: 'knowledge',
            content: 'duplicate body',
            content_hash: hash,
            confidence: 0.7,
            signal_count: i + 1,
            derived_by: 'test',
          }}`,
        )
        .collect();
    }
    const summary = await dreamStepCompaction(db);
    assert.deepEqual(summary.errors, []);
    assert.equal(summary.dedup_clusters, 1);
    assert.equal(summary.dedup_merged, 1);
  } finally {
    await close(db);
  }
});

test('compaction telemetry row is written each run', async () => {
  const db = await fresh();
  try {
    await dreamStepCompaction(db);
    const [rows] = await db
      .query(surql`SELECT count() AS n FROM compaction_telemetry GROUP ALL`)
      .collect();
    assert.equal(rows[0].n, 1);
  } finally {
    await close(db);
  }
});
