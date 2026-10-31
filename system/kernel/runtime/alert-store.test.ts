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
  markEscalated,
  markRepairAttempted,
  pruneResolvedAlerts,
  recordAlert,
  recordDeferredObservation,
  resolveAlert,
  setOutcome,
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

test('recordAlert samples observations at powers of ten', () => {
  const db = freshDb();
  for (let i = 0; i < 12; i++) {
    recordAlert(db, { severity: 'warning', source: 's', key: 'k', message: `fire ${i + 1}` });
  }
  const row = listAlerts(db, {})[0];
  assert.strictEqual(row.fire_count, 12);
  const ctx = JSON.parse(row.context_json ?? '{}');
  const ns = ctx._observations.map((o: { n: number }) => o.n);
  assert.deepStrictEqual(ns, [1, 10]); // sampled 1st and 10th only
  assert.strictEqual(ctx._observations[1].message, 'fire 10');
  closeDb(db);
});

test('caller context keys merge instead of overwriting', () => {
  const db = freshDb();
  recordAlert(db, {
    severity: 'warning',
    source: 's',
    key: 'k',
    message: 'a',
    context: { first: 1 },
  });
  recordAlert(db, {
    severity: 'warning',
    source: 's',
    key: 'k',
    message: 'b',
    context: { second: 2 },
  });
  const ctx = JSON.parse(listAlerts(db, {})[0].context_json ?? '{}');
  assert.strictEqual(ctx.first, 1); // preserved
  assert.strictEqual(ctx.second, 2); // added
  closeDb(db);
});

test('recordDeferredObservation appends to open parent, no-ops without one', () => {
  const db = freshDb();
  assert.strictEqual(
    recordDeferredObservation(db, 's', 'parent', 'child.inv', 'child failing'),
    false,
  );
  recordAlert(db, { severity: 'warning', source: 's', key: 'parent', message: 'parent down' });
  assert.strictEqual(
    recordDeferredObservation(db, 's', 'parent', 'child.inv', 'child failing'),
    true,
  );
  const ctx = JSON.parse(listAlerts(db, {})[0].context_json ?? '{}');
  const deferred = ctx._observations.filter(
    (o: { deferred?: string }) => o.deferred === 'child.inv',
  );
  assert.strictEqual(deferred.length, 1);
  assert.strictEqual(deferred[0].message, 'child failing');
  closeDb(db);
});

test('repeated deferred observations replace in place and preserve sampled history', () => {
  const db = freshDb();
  recordAlert(db, { severity: 'warning', source: 's', key: 'parent', message: 'down' });
  for (let i = 0; i < 12; i++) {
    recordDeferredObservation(db, 's', 'parent', 'child.a', `tick ${i}`);
  }
  const ctx = JSON.parse(listAlerts(db, {})[0].context_json ?? '{}');
  const deferred = ctx._observations.filter((o: { deferred?: string }) => o.deferred === 'child.a');
  assert.strictEqual(deferred.length, 1); // replaced, not appended
  assert.strictEqual(deferred[0].message, 'tick 11'); // latest wins
  const sampled = ctx._observations.filter((o: { n?: number }) => o.n === 1);
  assert.strictEqual(sampled.length, 1); // n:1 sample survived 12 deferrals
  closeDb(db);
});

test('distinct children still get distinct deferred entries', () => {
  const db = freshDb();
  recordAlert(db, { severity: 'warning', source: 's', key: 'parent', message: 'down' });
  recordDeferredObservation(db, 's', 'parent', 'child.a', 'a');
  recordDeferredObservation(db, 's', 'parent', 'child.b', 'b');
  const ctx = JSON.parse(listAlerts(db, {})[0].context_json ?? '{}');
  assert.strictEqual(ctx._observations.filter((o: { deferred?: string }) => o.deferred).length, 2);
  closeDb(db);
});

test('markRepairAttempted wins once per incident; resolve credits the repair', () => {
  const db = freshDb();
  recordAlert(db, { severity: 'warning', source: 'invariant', key: 'x', message: 'm' });
  assert.strictEqual(markRepairAttempted(db, 'invariant', 'x'), true);
  assert.strictEqual(markRepairAttempted(db, 'invariant', 'x'), false); // once per incident
  resolveAlert(db, 'invariant', 'x');
  const row = listAlerts(db, { all: true })[0];
  assert.strictEqual(row.outcome, 'repaired'); // credited at resolve time
  // a NEW incident for the same key starts a fresh ladder
  recordAlert(db, { severity: 'warning', source: 'invariant', key: 'x', message: 'm2' });
  assert.strictEqual(markRepairAttempted(db, 'invariant', 'x'), true);
  closeDb(db);
});

test('markEscalated requires a prior repair attempt and fires once', () => {
  const db = freshDb();
  recordAlert(db, { severity: 'warning', source: 'invariant', key: 'y', message: 'm' });
  assert.strictEqual(markEscalated(db, 'invariant', 'y'), false); // no repair attempt yet
  markRepairAttempted(db, 'invariant', 'y');
  assert.strictEqual(markEscalated(db, 'invariant', 'y'), true);
  assert.strictEqual(markEscalated(db, 'invariant', 'y'), false); // once
  closeDb(db);
});

test('setOutcome needs-human sticks on the open row', () => {
  const db = freshDb();
  recordAlert(db, { severity: 'warning', source: 'invariant', key: 'z', message: 'm' });
  setOutcome(db, 'invariant', 'z', 'needs-human');
  assert.strictEqual(listAlerts(db, {})[0].outcome, 'needs-human');
  closeDb(db);
});
