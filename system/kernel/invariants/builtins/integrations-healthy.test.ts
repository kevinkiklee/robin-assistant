import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { integrationsHealthyInvariant } from './integrations-healthy.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-inv-integ-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('integrations.healthy: ok when no integrations have errors', async () => {
  const db = freshDb();
  const inv = integrationsHealthyInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('integrations.healthy: ok when consecutive_errors is below threshold (5)', async () => {
  const db = freshDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO integration_state (integration_name, key, value, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('flaky', 'consecutive_errors', '3', now);

  const r = await integrationsHealthyInvariant(db).check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('integrations.healthy: fails when an integration crosses the 5-error threshold', async () => {
  const db = freshDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO integration_state (integration_name, key, value, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('dead', 'consecutive_errors', '7', now);

  const r = await integrationsHealthyInvariant(db).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /dead\(7\)/);
  closeDb(db);
});

test('integrations.healthy: reports every broken integration in the message', async () => {
  const db = freshDb();
  const now = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO integration_state (integration_name, key, value, updated_at) VALUES (?, ?, ?, ?)`,
  );
  ins.run('google_drive', 'consecutive_errors', '12', now);
  ins.run('youtube', 'consecutive_errors', '8', now);
  ins.run('whoop', 'consecutive_errors', '1', now); // below threshold, should NOT appear

  const r = await integrationsHealthyInvariant(db).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /google_drive\(12\)/);
  assert.match(r.message ?? '', /youtube\(8\)/);
  assert.doesNotMatch(r.message ?? '', /whoop/);
  closeDb(db);
});

test('integrations.healthy: invariant metadata is set for runbook generation', () => {
  const db = freshDb();
  const inv = integrationsHealthyInvariant(db);
  assert.equal(inv.name, 'integrations.healthy');
  assert.equal(inv.severity, 'warning');
  assert.ok(inv.symptom.length > 0);
  assert.ok(inv.cause.length > 0);
  assert.ok(inv.fix.length > 0);
  closeDb(db);
});
