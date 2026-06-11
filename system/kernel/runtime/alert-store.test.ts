import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import {
  ackAlert,
  listAlerts,
  pruneResolvedAlerts,
  recordAlert,
  resolveAlert,
} from './alert-store.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-alert-store-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('recordAlert opens one row and dedups re-fires into it', () => {
  const d = freshDb();
  const a = recordAlert(d, {
    severity: 'warning',
    source: 'invariant',
    key: 'integration.staleness:whoop',
    message: 'stale 13h',
  });
  const b = recordAlert(d, {
    severity: 'warning',
    source: 'invariant',
    key: 'integration.staleness:whoop',
    message: 'stale 14h',
  });
  assert.equal(a.id, b.id);
  const open = listAlerts(d, {});
  assert.equal(open.length, 1);
  assert.equal(open[0].fire_count, 2);
  assert.equal(open[0].message, 'stale 14h'); // message refreshed
  closeDb(d);
});

test('recordAlert escalates severity in place, never downgrades', () => {
  const d = freshDb();
  recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  recordAlert(d, { severity: 'critical', source: 'invariant', key: 'k', message: 'm' });
  assert.equal(listAlerts(d, {})[0].severity, 'critical');
  recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  assert.equal(listAlerts(d, {})[0].severity, 'critical');
  closeDb(d);
});

test('resolveAlert stamps resolved_at; recurrence opens a new row', () => {
  const d = freshDb();
  const a = recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  resolveAlert(d, 'invariant', 'k');
  assert.equal(listAlerts(d, {}).length, 0);
  const b = recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  assert.notEqual(a.id, b.id);
  assert.equal(listAlerts(d, { all: true }).length, 2);
  closeDb(d);
});

test('resolveAlert on nothing open is a no-op', () => {
  const d = freshDb();
  resolveAlert(d, 'invariant', 'never-fired'); // must not throw
  closeDb(d);
});

test('ack hides from default list but row stays open', () => {
  const d = freshDb();
  const a = recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  ackAlert(d, a.id);
  assert.equal(listAlerts(d, {}).length, 0);
  assert.equal(listAlerts(d, { includeAcked: true }).length, 1);
  closeDb(d);
});

test('pruneResolvedAlerts removes only old resolved rows', () => {
  const d = freshDb();
  recordAlert(d, { severity: 'warning', source: 's', key: 'old', message: 'm' });
  resolveAlert(d, 's', 'old');
  d.prepare(`UPDATE alerts SET resolved_at = datetime('now','-40 days') WHERE key='old'`).run();
  recordAlert(d, { severity: 'warning', source: 's', key: 'live', message: 'm' });
  assert.equal(pruneResolvedAlerts(d, 30), 1);
  assert.equal(listAlerts(d, { all: true }).length, 1);
  closeDb(d);
});

test('recordAlert: two connections on same file — second call refreshes, yields fire_count 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-alert-store-xconn-'));
  const dbPath = join(dir, 'robin.sqlite');

  const connA = openDb(dbPath);
  applyMigrations(connA, allMigrations);

  const connB = openDb(dbPath);

  recordAlert(connA, { severity: 'warning', source: 'test', key: 'xconn', message: 'first' });
  recordAlert(connB, { severity: 'warning', source: 'test', key: 'xconn', message: 'second' });

  const rows = listAlerts(connA, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fire_count, 2);

  closeDb(connA);
  closeDb(connB);
});
