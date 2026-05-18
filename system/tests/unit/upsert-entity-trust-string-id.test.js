// Regression for the biographer hot-loop bug:
// `applyTrustMerge` interpolated entityId straight into a surql tagged
// template. When stage1Resolve returns a bare string id (e.g.
// "entities:place__new_york_city" from a legacy or untyped SELECT), surql
// treats it as a string parameter, not a record reference, and the daemon
// loop logs `Cannot execute UPDATE statement using value: '...'` on every
// accumulator tick. The fix wraps string ids in StringRecordId before the
// query.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { upsertEntityCascade } from '../../cognition/biographer/upsert-entity.js';
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

// Stub embedder that returns a constant vector — stage 2 is best-effort in
// the cascade, so any well-shaped 1024-dim vector keeps the test focused on
// the stage-1 + trust-merge path.
const stubEmbedder = {
  async embed() {
    return new Float32Array(1024).fill(0);
  },
};

test('upsertEntityCascade tolerates a string id from stage1 without UPDATE failure', async () => {
  const db = await fresh();
  try {
    // Pre-seed an entity with a stage-1-resolvable name. Subsequent upserts
    // with the same (name, type) hit stage 1 and run applyTrustMerge against
    // the existing row. Trigger merge by passing a less-trusted source so
    // the UPDATE branch fires.
    await db
      .query(
        surql`CREATE entities:place__new_york_city CONTENT {
          name: 'New York City',
          name_lower: 'new york city',
          type: 'place',
          derived_from_trust: 'trusted'
        }`,
      )
      .collect();
    // First call: same trust, no UPDATE needed. Must succeed.
    const r1 = await upsertEntityCascade(db, stubEmbedder, {
      name: 'New York City',
      type: 'place',
      derived_from_trust: 'trusted',
    });
    assert.equal(r1.stage, 1, 'stage 1 hit');
    assert.equal(r1.created, false);
    // Second call: bump trust DOWNwards to fire the UPDATE branch. This is
    // the call that used to log `Cannot execute UPDATE statement using
    // value: 'entities:place__new_york_city'` and crash the batch.
    const r2 = await upsertEntityCascade(db, stubEmbedder, {
      name: 'New York City',
      type: 'place',
      derived_from_trust: 'untrusted',
    });
    assert.equal(r2.stage, 1, 'stage 1 hit again');
    assert.equal(r2.derived_from_trust, 'untrusted', 'trust merged to worst-case');
    // Verify the row landed.
    const [rows] = await db
      .query("SELECT derived_from_trust FROM entities:place__new_york_city")
      .collect();
    assert.equal(rows[0]?.derived_from_trust, 'untrusted');
  } finally {
    await close(db);
  }
});
