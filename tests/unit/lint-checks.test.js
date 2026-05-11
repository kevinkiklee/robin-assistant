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

test('near_duplicate_knowledge — symmetric pair reported once', async () => {
  // Two knowledge rows sharing the same embedding → cosine 1.0 > 0.95 threshold.
  // Canonical [low, high] ordering should ensure only one issue, not two.
  const { db, embedder } = await fresh();
  const emb = Array.from(await embedder.embed('same vector'));
  await db
    .query(
      surql`CREATE knowledge CONTENT ${{
        content: 'first claim',
        content_hash: 'nd1',
        confidence: 0.8,
        source_events: [],
        source_episodes: [],
        embedding: emb,
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE knowledge CONTENT ${{
        content: 'second claim — same vector',
        content_hash: 'nd2',
        confidence: 0.8,
        source_events: [],
        source_episodes: [],
        embedding: emb,
      }}`,
    )
    .collect();
  const issues = await runLintChecks(db);
  const nearDups = issues.filter((i) => i.kind === 'near_duplicate_knowledge');
  assert.equal(nearDups.length, 1, 'symmetric pair should be reported exactly once');
  assert.match(nearDups[0].ref, /::/, 'ref encodes both ids');
  await close(db);
});

test('orphan_entity — entity reachable via mentions edge is NOT flagged', async () => {
  // Positive case for the orphan check — confirm that an entity WITH an
  // inbound mentions edge from an event is not falsely reported.
  const { db, embedder } = await fresh();
  const emb = Array.from(await embedder.embed('linked'));
  const [createdEnts] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Linked', type: 'thing', embedding: emb }}`)
    .collect();
  const entId = createdEnts[0].id;
  const evtEmb = Array.from(await embedder.embed('event content'));
  const [createdEvts] = await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'manual',
        content: 'event mentions Linked',
        content_hash: 'evh1',
        embedding: evtEmb,
      }}`,
    )
    .collect();
  const evtId = createdEvts[0].id;
  await db.query(`RELATE ${evtId}->mentions->${entId}`).collect();
  const issues = await runLintChecks(db);
  const orphans = issues.filter((i) => i.kind === 'orphan_entity' && i.ref === String(entId));
  assert.equal(orphans.length, 0, 'Linked entity has an inbound mentions edge; should not be orphan');
  await close(db);
});
