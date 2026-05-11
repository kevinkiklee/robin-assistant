// lint-checks.test.js — covers src/jobs/lint-checks.js after the schema
// redesign. Knowledge rows now live in `memos` with `kind='knowledge'`;
// the old `knowledge` table is gone. Edges live in a single `edges` table
// with a `kind` discriminator; the old `mentions` per-relation table is gone.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { runLintChecks } from '../../cognition/jobs/lint-checks.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return { db, embedder: createStubEmbedder({ dimension: 1024 }) };
}

test('orphan_entity — entity with no inbound edges is flagged', async () => {
  const { db } = await fresh();
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Orphan', type: 'thing' }}`).collect();
  const issues = await runLintChecks(db);
  assert.ok(issues.some((i) => i.kind === 'orphan_entity'));
  await close(db);
});

test('duplicate_entity — same name+type creates a duplicate issue', async () => {
  const { db } = await fresh();
  await db.query(surql`CREATE entities CONTENT ${{ name: 'X', type: 'thing' }}`).collect();
  await db.query(surql`CREATE entities CONTENT ${{ name: 'x', type: 'thing' }}`).collect();
  const issues = await runLintChecks(db);
  assert.ok(issues.some((i) => i.kind === 'duplicate_entity'));
  await close(db);
});

test('stale_knowledge — low confidence + future cutoff triggers stale', async () => {
  const { db, embedder } = await fresh();
  await store.note(db, embedder, 'knowledge', {
    content: 'old stale claim',
    confidence: 0.1,
    derived_by: 'manual',
  });
  // Pass a cutoffDate in the future so all existing rows appear older than cutoff.
  const futureDate = new Date(Date.now() + 999 * 86_400_000);
  const issues = await runLintChecks(db, { cutoffDate: futureDate });
  assert.ok(
    issues.some((i) => i.kind === 'stale_knowledge'),
    'expected stale_knowledge issue',
  );
  await close(db);
});

test('runLintChecks — issues sorted severity desc', async () => {
  const { db } = await fresh();
  await db.query(surql`CREATE entities CONTENT ${{ name: 'A', type: 'thing' }}`).collect();
  await db.query(surql`CREATE entities CONTENT ${{ name: 'B', type: 'thing' }}`).collect();
  const issues = await runLintChecks(db);
  assert.ok(issues.every((i) => typeof i.severity === 'number'));
  for (let i = 1; i < issues.length; i++) {
    assert.ok(issues[i - 1].severity >= issues[i].severity);
  }
  await close(db);
});

test('near_duplicate_knowledge — symmetric pair reported once', async () => {
  // Two knowledge memos with the same embedding → cosine 1.0 > 0.95 threshold.
  // Canonical [low, high] ordering ensures only one issue.
  const { db, embedder } = await fresh();
  // Same embedding text triggers identical vectors from the stub embedder.
  // The memos table dedupes by content_hash, so vary the content slightly
  // but feed the same text into the embedder via a wrapper.
  const sameVec = await embedder.embed('shared vector seed');
  const constEmbedder = {
    dimension: 1024,
    modelId: 'const',
    embed: async () => sameVec,
    embedBatch: async (xs) => xs.map(() => sameVec),
  };
  await store.note(db, constEmbedder, 'knowledge', {
    content: 'first claim',
    confidence: 0.8,
    derived_by: 'manual',
  });
  await store.note(db, constEmbedder, 'knowledge', {
    content: 'second claim — same vector',
    confidence: 0.8,
    derived_by: 'manual',
  });
  const issues = await runLintChecks(db);
  const nearDups = issues.filter((i) => i.kind === 'near_duplicate_knowledge');
  assert.equal(nearDups.length, 1, 'symmetric pair should be reported exactly once');
  assert.match(nearDups[0].ref, /::/, 'ref encodes both ids');
  await close(db);
});

test('orphan_entity — entity reachable via mentions edge is NOT flagged', async () => {
  // Positive case for the orphan check — entity with an inbound mentions edge
  // from an event should not be reported. mentions now lives on the unified
  // `edges` table with kind='mentions'; we route through store.relate.
  const { db } = await fresh();
  const [createdEnts] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Linked', type: 'thing' }}`)
    .collect();
  const entId = createdEnts[0].id;
  const [createdEvts] = await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'manual',
        content: 'event mentions Linked',
        content_hash: 'evh1',
      }}`,
    )
    .collect();
  const evtId = createdEvts[0].id;
  await store.relate(db, evtId, entId, 'mentions');
  const issues = await runLintChecks(db);
  const orphans = issues.filter((i) => i.kind === 'orphan_entity' && i.ref === String(entId));
  assert.equal(
    orphans.length,
    0,
    'Linked entity has an inbound mentions edge; should not be orphan',
  );
  await close(db);
});
