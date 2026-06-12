import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { captureVolumeSaneInvariant } from './capture-volume-sane.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-capture-volume-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Insert a session.captured event `hoursAgo` hours before now (ISO ts, as capture writes). */
function insertCapture(db: RobinDb, hoursAgo: number): void {
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload) VALUES (?, 'session.captured', 'capture', 'ok', '{}')`,
  ).run(new Date(Date.now() - hoursAgo * 3_600_000).toISOString());
}

test('capture-volume: quiet day → ok', async () => {
  const db = freshDb();
  for (let i = 0; i < 50; i++) insertCapture(db, (i % 23) + 0.5);
  const r = await captureVolumeSaneInvariant(db, { threshold: 200 }).check();
  assert.equal(r.ok, true, JSON.stringify(r));
  closeDb(db);
});

test('capture-volume: a junk storm fires with the count', async () => {
  // The 2026-06-12 self-capture loop reached 840-6,344 captures/day; human +
  // automated-loop baseline is 15-80/day. Anything past the threshold means a
  // new automated source is being captured and silently flooding the pipeline.
  const db = freshDb();
  for (let i = 0; i < 250; i++) insertCapture(db, (i % 20) + 0.5);
  const r = await captureVolumeSaneInvariant(db, { threshold: 200 }).check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /250 sessions captured in 24h/);
  assert.ok(r.remediation, 'remediation should be present');
  closeDb(db);
});

test('capture-volume: old events outside the 24h window do not count', async () => {
  const db = freshDb();
  for (let i = 0; i < 250; i++) insertCapture(db, 30 + (i % 20));
  const r = await captureVolumeSaneInvariant(db, { threshold: 200 }).check();
  assert.equal(r.ok, true, JSON.stringify(r));
  closeDb(db);
});

test('capture-volume: default threshold is 200', async () => {
  const db = freshDb();
  const inv = captureVolumeSaneInvariant(db);
  assert.equal(inv.name, 'capture.volume_sane');
  assert.equal(inv.severity, 'warning');
  const r = await inv.check();
  assert.equal(r.ok, true);
  closeDb(db);
});
