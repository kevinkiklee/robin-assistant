import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath } from '../../lib/paths.ts';
import { runMemoryCommand, sampleByDomain } from './memory.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cli-memory-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Build a temp user-data dir with a fully migrated SQLite DB. */
function freshUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cli-memory-ud-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(dbFilePath(dir));
  applyMigrations(db, allMigrations);
  closeDb(db);
  return dir;
}

test('sampleByDomain counts rows by domain and returns recent sample', () => {
  const db = freshDb();

  // Insert 2 rows with domain='health', 1 with domain='creative', 1 with domain=NULL
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, confidence, status, domain)
     VALUES (?, ?, ?, 'pending', ?)`,
  ).run('sleep-quality', 'Kevin sleeps around 7 hours per night', 0.9, 'health');
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, confidence, status, domain)
     VALUES (?, ?, ?, 'pending', ?)`,
  ).run('fitness', 'Kevin runs regularly', 0.8, 'health');
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, confidence, status, domain)
     VALUES (?, ?, ?, 'pending', ?)`,
  ).run('photography', 'Kevin shoots street photography on a Nikon Zf', 0.95, 'creative');
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, confidence, status, domain)
     VALUES (?, ?, ?, 'pending', ?)`,
  ).run('misc', 'Kevin uses pnpm as his package manager', 0.7, null);

  const result = sampleByDomain(db, 30);

  // Count assertions
  assert.equal(result.counts.health, 2, 'health count should be 2');
  assert.equal(result.counts.creative, 1, 'creative count should be 1');
  assert.equal(result.counts['(untagged)'], 1, 'untagged count should be 1');

  // recent length bounded by limit
  assert.ok(result.recent.length <= 30, 'recent.length should be <= 30');

  // All 4 rows present since limit=30 and we only have 4
  assert.equal(result.recent.length, 4, 'recent should contain all 4 rows');

  closeDb(db);
});

test('runMemoryCommand degate dry-run: does not throw, leaves dev-artifact row pending', async () => {
  const dataDir = freshUserData();
  const prev = process.env.ROBIN_USER_DATA_DIR;
  process.env.ROBIN_USER_DATA_DIR = dataDir;
  try {
    // Seed a dev-artifact candidate directly into the DB.
    const db = openDb(dbFilePath(dataDir));
    db.prepare(`INSERT INTO belief_candidates (topic, claim, status) VALUES (?, ?, 'pending')`).run(
      'robin-tools',
      'Robin uses MCP servers to expose integrations.',
    );
    const id = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
    closeDb(db);

    // Dry-run (default — no --apply): should not throw.
    await assert.doesNotReject(runMemoryCommand(['degate']));

    // Row must still be pending — dry-run never writes.
    const db2 = openDb(dbFilePath(dataDir));
    const row = db2.prepare(`SELECT status FROM belief_candidates WHERE id = ?`).get(id) as {
      status: string;
    };
    closeDb(db2);
    assert.equal(row.status, 'pending', 'dry-run must not write status change');
  } finally {
    if (prev === undefined) delete process.env.ROBIN_USER_DATA_DIR;
    else process.env.ROBIN_USER_DATA_DIR = prev;
  }
});
