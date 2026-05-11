import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

// Drift-detection unit test exercises the readConfig + DB query paths in
// isolation. The full daemon-boot wiring lives in src/daemon/server.js; an
// integration test exists in install-flow.test.js (Task 11).

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test('drift check passes when config + runtime row match', async () => {
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  try {
    const migrationsDir = resolve(import.meta.dirname, '../../data/db/migrations');
    await runMigrations(db, migrationsDir);
    const [rows] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'embedder')`)
      .collect();
    assert.equal(rows[0].value.active_profile, 'mxbai-1024');

    // The drift check itself: profiles match → no error.
    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config.json'), 'utf-8'));
    assert.equal(cfg.embedder_profile, rows[0].value.active_profile);
  } finally {
    await close(db);
  }
});

test('drift check detects mismatch', async () => {
  // Apply migrations under qwen3-4096 → runtime row records qwen3.
  await writeConfig({ embedder_profile: 'qwen3-4096' });
  const db = await connect({ engine: 'mem://' });
  try {
    const migrationsDir = resolve(import.meta.dirname, '../../data/db/migrations');
    await runMigrations(db, migrationsDir);

    // Hand-edit config to mxbai while runtime row still says qwen3.
    await writeConfig({ embedder_profile: 'mxbai-1024' });

    const cfg = JSON.parse(readFileSync(join(tmpHome, 'config.json'), 'utf-8'));
    const [rows] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'embedder')`)
      .collect();
    const runtimeProfile = rows[0]?.value?.active_profile;

    // Drift detected: config says one thing, runtime row says another.
    assert.equal(cfg.embedder_profile, 'mxbai-1024');
    assert.equal(runtimeProfile, 'qwen3-4096');
    assert.notEqual(cfg.embedder_profile, runtimeProfile);
  } finally {
    await close(db);
  }
});
