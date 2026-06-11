import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RobinDb } from '../../brain/memory/db.ts';
import { migration024 } from '../../brain/memory/migrations/024-alerts.ts';
import {
  ackAlert,
  listAlerts,
  pruneResolvedAlerts,
  recordAlert,
  resolveAlert,
} from './alert-store.ts';

function db(): RobinDb {
  const d = new Database(':memory:') as unknown as RobinDb;
  migration024.up(d);
  return d;
}

test('recordAlert opens one row and dedups re-fires into it', () => {
  const d = db();
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
});

test('recordAlert escalates severity in place, never downgrades', () => {
  const d = db();
  recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  recordAlert(d, { severity: 'critical', source: 'invariant', key: 'k', message: 'm' });
  assert.equal(listAlerts(d, {})[0].severity, 'critical');
  recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  assert.equal(listAlerts(d, {})[0].severity, 'critical');
});

test('resolveAlert stamps resolved_at; recurrence opens a new row', () => {
  const d = db();
  const a = recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  resolveAlert(d, 'invariant', 'k');
  assert.equal(listAlerts(d, {}).length, 0);
  const b = recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  assert.notEqual(a.id, b.id);
  assert.equal(listAlerts(d, { all: true }).length, 2);
});

test('resolveAlert on nothing open is a no-op', () => {
  const d = db();
  resolveAlert(d, 'invariant', 'never-fired'); // must not throw
});

test('ack hides from default list but row stays open', () => {
  const d = db();
  const a = recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  ackAlert(d, a.id);
  assert.equal(listAlerts(d, {}).length, 0);
  assert.equal(listAlerts(d, { includeAcked: true }).length, 1);
});

test('pruneResolvedAlerts removes only old resolved rows', () => {
  const d = db();
  recordAlert(d, { severity: 'warning', source: 's', key: 'old', message: 'm' });
  resolveAlert(d, 's', 'old');
  d.prepare(`UPDATE alerts SET resolved_at = datetime('now','-40 days') WHERE key='old'`).run();
  recordAlert(d, { severity: 'warning', source: 's', key: 'live', message: 'm' });
  assert.equal(pruneResolvedAlerts(d, 30), 1);
  assert.equal(listAlerts(d, { all: true }).length, 1);
});
