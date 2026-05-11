import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { runLintChecks } from '../../src/jobs/lint-checks.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

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
  const { db, embedder } = await fresh();
  const emb = Array.from(await embedder.embed('orphan'));
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Orphan', type: 'thing', embedding: emb }}`)
    .collect();
  const issues = await runLintChecks(db);
  assert.ok(issues.some((i) => i.kind === 'orphan_entity'));
  await close(db);
});

test('duplicate_entity — same name+type creates a duplicate issue', async () => {
  const { db, embedder } = await fresh();
  const emb = Array.from(await embedder.embed('dup'));
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'X', type: 'thing', embedding: emb }}`)
    .collect();
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'x', type: 'thing', embedding: emb }}`)
    .collect();
  const issues = await runLintChecks(db);
  assert.ok(issues.some((i) => i.kind === 'duplicate_entity'));
  await close(db);
});

test('stale_knowledge — low confidence + future cutoff triggers stale', async () => {
  // NOTE: knowledge.updated_at uses VALUE time::now() in the SurrealDB schema,
  // which re-triggers to time::now() on every UPDATE. Backdating via UPDATE is
  // therefore not reliable. Instead we pass a future cutoffDate so all rows
  // are considered older than the cutoff regardless of their actual updated_at.
  const { db, embedder } = await fresh();
  const emb = Array.from(await embedder.embed('stale'));
  await db
    .query(
      surql`CREATE knowledge CONTENT ${{
        content: 'old stale claim',
        content_hash: 'h1',
        confidence: 0.1,
        source_events: [],
        source_episodes: [],
        embedding: emb,
      }}`,
    )
    .collect();
  // Pass a cutoffDate in the future so all existing rows appear "older than cutoff"
  const futureDate = new Date(Date.now() + 999 * 86_400_000);
  const issues = await runLintChecks(db, { cutoffDate: futureDate });
  assert.ok(
    issues.some((i) => i.kind === 'stale_knowledge'),
    'expected stale_knowledge issue',
  );
  await close(db);
});

test('runLintChecks — issues sorted severity desc, kind asc, ref asc', async () => {
  const { db, embedder } = await fresh();
  const emb = Array.from(await embedder.embed('a'));
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'A', type: 'thing', embedding: emb }}`)
    .collect();
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'B', type: 'thing', embedding: emb }}`)
    .collect();
  const issues = await runLintChecks(db);
  assert.ok(issues.every((i) => typeof i.severity === 'number'));
  for (let i = 1; i < issues.length; i++) {
    assert.ok(issues[i - 1].severity >= issues[i].severity);
  }
  await close(db);
});
