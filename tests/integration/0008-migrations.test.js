import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { writeConfig } from '../../src/runtime/config.js';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

const PROFILE_DIM = {
  'mxbai-1024': 1024,
  'qwen3-4096': 4096,
  'gemini-3072': 3072,
};

for (const profile of ['mxbai-1024', 'qwen3-4096', 'gemini-3072']) {
  test(`migrations apply for profile ${profile}; HNSW dim correct`, async () => {
    await writeConfig({ embedder_profile: profile });
    const db = await connect({ engine: 'mem://' });
    const migrationsDir = resolve(import.meta.dirname, '../../src/schema/migrations');
    await runMigrations(db, migrationsDir);

    const expectedDim = PROFILE_DIM[profile];
    const goodVec = Array.from({ length: expectedDim }, () => 0.1);
    const badVec = Array.from({ length: expectedDim - 1 }, () => 0.1);

    // events.embedding accepts good dim
    await db
      .query(
        surql`CREATE events CONTENT ${{
          source: 'cli',
          content: 'test events good',
          embedding: goodVec,
          content_hash: 'h-events-good',
        }}`,
      )
      .collect();

    // events.embedding rejects wrong dim
    await assert.rejects(() =>
      db
        .query(
          surql`CREATE events CONTENT ${{
            source: 'cli',
            content: 'test events bad',
            embedding: badVec,
            content_hash: 'h-events-bad',
          }}`,
        )
        .collect(),
    );

    // knowledge.embedding accepts good dim
    await db
      .query(
        surql`CREATE knowledge CONTENT ${{
          content: 'test knowledge good',
          content_hash: 'h-k-good',
          confidence: 0.5,
          source_events: [],
          source_episodes: [],
          embedding: goodVec,
        }}`,
      )
      .collect();

    // knowledge.embedding rejects wrong dim
    await assert.rejects(() =>
      db
        .query(
          surql`CREATE knowledge CONTENT ${{
            content: 'test knowledge bad',
            content_hash: 'h-k-bad',
            confidence: 0.5,
            source_events: [],
            source_episodes: [],
            embedding: badVec,
          }}`,
        )
        .collect(),
    );

    // entities.embedding accepts good dim
    await db
      .query(
        surql`CREATE entities CONTENT ${{
          name: 'TestEntity',
          type: 'thing',
          embedding: goodVec,
        }}`,
      )
      .collect();

    // entities.embedding rejects wrong dim
    await assert.rejects(() =>
      db
        .query(
          surql`CREATE entities CONTENT ${{
            name: 'TestEntityBad',
            type: 'thing',
            embedding: badVec,
          }}`,
        )
        .collect(),
    );

    // runtime:embedder row written with correct profile + dimension
    const [rows] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'embedder')`)
      .collect();
    assert.equal(rows.length, 1, 'runtime:embedder row exists');
    assert.equal(rows[0].value.profile, profile);
    assert.equal(rows[0].value.dimension, expectedDim);

    await close(db);
  });
}

test('migrations refuse without embedder_profile config', async () => {
  // Don't write config — expect runMigrations to reject.
  const db = await connect({ engine: 'mem://' });
  const migrationsDir = resolve(import.meta.dirname, '../../src/schema/migrations');
  await assert.rejects(() => runMigrations(db, migrationsDir), /no embedder profile configured/);
  await close(db);
});
