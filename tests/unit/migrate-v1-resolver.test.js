import assert from 'node:assert';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createResolver } from '../../src/migrate-v1/resolver.js';
import { writeConfig } from '../../src/runtime/config.js';
import { paths } from '../../src/runtime/data-store.js';

test('resolver round-trips entity + episode mappings', async () => {
  const tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
  await writeConfig({ embedder_profile: 'mxbai-1024' });

  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths().migrationsDir);
    const r = createResolver(db);
    r.set('entity', 'entity:abc', 'entities:newabc');
    r.set('episode', 'episode:xyz', 'episodes:newxyz');
    assert.equal(r.get('entity', 'entity:abc'), 'entities:newabc');
    await r.persist();

    const r2 = createResolver(db);
    await r2.load();
    assert.equal(r2.get('episode', 'episode:xyz'), 'episodes:newxyz');
    assert.equal(r2.get('entity', 'entity:nonexistent'), null);
  } finally {
    await close(db);
  }
});

test('resolver tracks sizes per kind', () => {
  const r = createResolver(null); // db not needed for in-memory operations
  r.set('entity', 'a', 'A');
  r.set('entity', 'b', 'B');
  r.set('capture', 'c', 'C');
  const sizes = r.sizes();
  assert.equal(sizes.entity, 2);
  assert.equal(sizes.episode, 0);
  assert.equal(sizes.capture, 1);
});

test('resolver rejects unknown kind', () => {
  const r = createResolver(null);
  assert.throws(() => r.set('unknown', 'a', 'A'));
});
