import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { recordAlert, resolveAlert } from '../../kernel/runtime/alert-store.ts';
import { listAlertsText, runAck } from './alerts.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cli-alerts-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('listAlertsText renders open alerts with age and severity', () => {
  const db = freshDb();

  const a = recordAlert(db, {
    severity: 'critical',
    source: 'test',
    key: 'integration.crash:whoop',
    message: 'crash loop detected',
  });
  const b = recordAlert(db, {
    severity: 'warning',
    source: 'test',
    key: 'integration.staleness:calendar',
    message: 'stale 2h',
  });

  const text = listAlertsText(db, {});

  // Both alerts present
  assert.ok(text.includes(`#${a.id}`), `missing #${a.id}`);
  assert.ok(text.includes(`#${b.id}`), `missing #${b.id}`);

  // Severity tags
  assert.ok(text.includes('[critical]'), 'missing [critical]');
  assert.ok(text.includes('[warning]'), 'missing [warning]');

  // Keys
  assert.ok(text.includes('integration.crash:whoop'), 'missing key for critical alert');
  assert.ok(text.includes('integration.staleness:calendar'), 'missing key for warning alert');

  // Messages
  assert.ok(text.includes('crash loop detected'), 'missing message for critical alert');
  assert.ok(text.includes('stale 2h'), 'missing message for warning alert');

  // fire_count
  assert.ok(text.includes('fired 1×'), 'missing fire count');

  // Just-created alerts should show age ~0h (not e.g. timezone offset hours)
  const ageMatch = text.match(/first seen (\d+)h ago/);
  assert.ok(ageMatch, 'missing age string');
  assert.equal(Number(ageMatch![1]), 0, 'just-created alert should show 0h age');

  closeDb(db);
});

test('listAlertsText says "No open alerts." when clean', () => {
  const db = freshDb();
  const text = listAlertsText(db, {});
  assert.equal(text, 'No open alerts.');
  closeDb(db);
});

test('listAlertsText --all includes resolved rows', () => {
  const db = freshDb();

  // Record and immediately resolve one
  recordAlert(db, {
    severity: 'warning',
    source: 'test',
    key: 'job.failure:embedder',
    message: 'embedder died',
  });
  resolveAlert(db, 'test', 'job.failure:embedder');

  // Record an open one
  recordAlert(db, {
    severity: 'info',
    source: 'test',
    key: 'integration.staleness:whoop',
    message: 'stale 1h',
  });

  const textOpen = listAlertsText(db, {});
  assert.ok(!textOpen.includes('resolved'), 'default list should not show resolved');

  const textAll = listAlertsText(db, { all: true });
  assert.ok(textAll.includes('resolved'), '--all should include resolved rows');

  closeDb(db);
});

test('runAck acks an existing id and reports unknown ids', () => {
  const db = freshDb();

  const a = recordAlert(db, {
    severity: 'warning',
    source: 'test',
    key: 'job.failure:biographer',
    message: 'biographer died',
  });

  // Ack success
  const successMsg = runAck(db, a.id);
  assert.equal(successMsg, `Acked alert #${a.id}.`);

  // Default list no longer shows acked row
  const text = listAlertsText(db, {});
  assert.equal(text, 'No open alerts.');

  // Unknown id
  const failMsg = runAck(db, 99999);
  assert.equal(failMsg, 'No open alert #99999.');

  closeDb(db);
});
