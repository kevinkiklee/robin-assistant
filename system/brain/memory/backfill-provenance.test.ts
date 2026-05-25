import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { backfillProvenance } from './backfill-provenance.ts';
import { believe } from './belief.ts';
import { closeDb, openDb } from './db.ts';
import { ingest } from './ingest.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-backfill-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('backfillProvenance: belief with integration.* sources gets reclassified to external', () => {
  const db = freshDb();
  // Insert a source event with an integration.* kind
  const src = ingest(db, null, {
    kind: 'integration.whoop',
    source: 'whoop',
    content: 'recovery score 72',
  });
  // Believe with sources pointing to that event, but no explicit provenance (defaults to unknown)
  believe(db, null, {
    topic: 'whoop.recovery',
    claim: 'recovery score 72',
    sources: [src.eventId],
    // provenance omitted → 'unknown'
    date: '2026-05-23',
  });

  const result = backfillProvenance(db);
  assert.equal(result.scanned, 1);
  assert.equal(result.updated, 1);

  // Verify the payload was updated in-place
  const row = db.prepare(`SELECT payload FROM events WHERE kind='belief.update' LIMIT 1`).get() as {
    payload: string;
  };
  const p = JSON.parse(row.payload) as Record<string, unknown>;
  assert.equal(p.provenance, 'external');

  closeDb(db);
});

test('backfillProvenance: belief with no sources stays unknown (untouched)', () => {
  const db = freshDb();
  believe(db, null, {
    topic: 'test.no-sources',
    claim: 'something',
    // no sources, no provenance → unknown
    date: '2026-05-23',
  });

  const result = backfillProvenance(db);
  assert.equal(result.scanned, 1);
  assert.equal(result.updated, 0);

  // Still unknown
  const row = db.prepare(`SELECT payload FROM events WHERE kind='belief.update' LIMIT 1`).get() as {
    payload: string;
  };
  const p = JSON.parse(row.payload) as Record<string, unknown>;
  assert.equal(p.provenance, 'unknown');

  closeDb(db);
});

test('backfillProvenance: re-running is a no-op (idempotent)', () => {
  const db = freshDb();
  const src = ingest(db, null, {
    kind: 'integration.spotify',
    source: 'spotify',
    content: 'listening to jazz',
  });
  believe(db, null, {
    topic: 'music.genre',
    claim: 'likes jazz',
    sources: [src.eventId],
    date: '2026-05-23',
  });

  // First run: classifies and updates
  const first = backfillProvenance(db);
  assert.equal(first.updated, 1);

  // Second run: provenance is now 'external' (not 'unknown'), so nothing to update
  const second = backfillProvenance(db);
  assert.equal(second.scanned, 1);
  assert.equal(second.updated, 0);

  closeDb(db);
});

test('backfillProvenance: skips already-classified beliefs (non-unknown provenance)', () => {
  const db = freshDb();
  const src = ingest(db, null, {
    kind: 'session.captured',
    source: 'session',
    content: 'kevin said he runs',
  });
  // Explicitly set first-party provenance — should NOT be touched
  believe(db, null, {
    topic: 'sport.running',
    claim: 'kevin runs',
    sources: [src.eventId],
    provenance: 'first-party',
    date: '2026-05-23',
  });

  const result = backfillProvenance(db);
  // scanned=1 but updated=0 because provenance != 'unknown'
  assert.equal(result.scanned, 1);
  assert.equal(result.updated, 0);

  const row = db.prepare(`SELECT payload FROM events WHERE kind='belief.update' LIMIT 1`).get() as {
    payload: string;
  };
  const p = JSON.parse(row.payload) as Record<string, unknown>;
  assert.equal(p.provenance, 'first-party');

  closeDb(db);
});
