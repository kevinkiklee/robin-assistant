import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { sampleByDomain } from './memory.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cli-memory-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
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
  assert.equal(result.counts['health'], 2, 'health count should be 2');
  assert.equal(result.counts['creative'], 1, 'creative count should be 1');
  assert.equal(result.counts['(untagged)'], 1, 'untagged count should be 1');

  // recent length bounded by limit
  assert.ok(result.recent.length <= 30, 'recent.length should be <= 30');

  // All 4 rows present since limit=30 and we only have 4
  assert.equal(result.recent.length, 4, 'recent should contain all 4 rows');

  closeDb(db);
});
