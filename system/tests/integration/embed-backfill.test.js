import assert from 'node:assert';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BoundQuery, surql } from 'surrealdb';
import { paths } from '../../config/data-store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { embedBackfillTick } from '../../data/embed/backfill.js';
import { activeProfile, embeddingTable } from '../../data/embed/profile-router.js';

function stubEmbedder({ dim = 1024 } = {}) {
  return {
    dimension: dim,
    embed: async () => new Float32Array(dim).fill(0.1),
    embedBatch: async (texts) => texts.map(() => new Float32Array(dim).fill(0.1)),
  };
}

async function insertEvent(db, content, { preEmbed = false, embedFailed = false } = {}) {
  // ts has READONLY DEFAULT — omit it. The events.embedding column was
  // removed in the redesign; embeddings now live in embeddings_<profile>_events.
  const doc = {
    content,
    source: 'migration',
    content_hash: content,
    trust: 'trusted',
    meta: embedFailed ? { embed_failed: true } : {},
  };
  const [created] = await db.query(surql`CREATE events CONTENT ${doc}`).collect();
  const row = Array.isArray(created) ? created[0] : created;
  if (preEmbed) {
    const profile = await activeProfile(db);
    const tbl = embeddingTable(profile, 'events');
    await db
      .query(
        new BoundQuery(
          'UPSERT type::record($tb, [$rec]) SET record = $rec, vector = $vec, ts = time::now()',
          { tb: tbl, rec: row.id, vec: Array(1024).fill(0.5) },
        ),
      )
      .collect();
  }
  return row.id;
}

test.beforeEach(async () => {
  const tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
});

test('backfill tick embeds rows with embedding=NONE', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths.source.migrations());
    const embedder = stubEmbedder();
    await insertEvent(db, 'one');
    await insertEvent(db, 'two');
    const r1 = await embedBackfillTick({ db, embedder, batch: 10 });
    assert.equal(r1.embedded, 2);
    const r2 = await embedBackfillTick({ db, embedder, batch: 10 });
    assert.equal(r2.embedded, 0);
  } finally {
    await close(db);
  }
});

test('backfill skips poison rows on next tick', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths.source.migrations());
    const failing = {
      dimension: 1024,
      embed: async () => {
        throw new Error('poison');
      },
      embedBatch: async () => {
        throw new Error('poison');
      },
    };
    await insertEvent(db, 'bad');
    const r = await embedBackfillTick({ db, embedder: failing, batch: 10 });
    assert.equal(r.embedded, 0);
    assert.equal(r.failed, 1);
    const [rows] = await db.query('SELECT meta.embed_failed AS f FROM events').collect();
    assert.equal(rows[0].f, true);

    // Subsequent tick must NOT re-process this row
    const ok = stubEmbedder();
    const r2 = await embedBackfillTick({ db, embedder: ok, batch: 10 });
    assert.equal(r2.embedded, 0);
  } finally {
    await close(db);
  }
});

test('backfill is idempotent on already-embedded rows', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths.source.migrations());
    const embedder = stubEmbedder();
    await insertEvent(db, 'pre-embedded', { preEmbed: true });
    const r = await embedBackfillTick({ db, embedder, batch: 10 });
    assert.equal(r.embedded, 0);
  } finally {
    await close(db);
  }
});
