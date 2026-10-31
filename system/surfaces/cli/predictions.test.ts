import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addRecovery, freshDb } from '../../brain/cognition/predictions/test-helpers.ts';
import { closeDb } from '../../brain/memory/db.ts';
import { proposalsText, specsText } from './predictions.ts';

test('predictions specs: lists spec’d open rows with a live reading once due', () => {
  const db = freshDb();
  addRecovery(db, '2026-03-10', 33);
  const ins = db.prepare(
    `INSERT INTO predictions (claim, confidence, deadline, spec) VALUES (?, ?, ?, ?)`,
  );
  ins.run(
    'due one',
    0.5,
    '2026-03-10',
    JSON.stringify({ source: 'whoop', metric: 'recovery_score', op: '>=', threshold: 70 }),
  );
  ins.run(
    'future one',
    0.5,
    '2027-03-31',
    JSON.stringify({
      source: 'finance',
      metric: 'balance',
      key: 'Acme Savings',
      op: '<',
      threshold: 12500,
    }),
  );
  ins.run('no spec', 0.5, '2026-12-31', null);
  const out = specsText(db, new Date('2026-10-07T08:00:00Z'));
  assert.match(out, /Open predictions: 3 \(2 with a spec\)/);
  assert.match(out, /whoop\.recovery_score >= 70 — reading 33/);
  assert.match(out, /finance\.balance\[Acme Savings\] < 12500 — due 2027-03-31/);
  closeDb(db);
});

test('predictions specs --backfill: dry-run text says nothing was written', () => {
  const text = proposalsText(
    [
      {
        id: 1,
        claim: 'c1',
        deadline: null,
        spec: { source: 'whoop', metric: 'rhr', op: '<', threshold: 48, at: '2026-10-09' },
      },
      { id: 2, claim: 'c2', deadline: null, spec: null, error: 'unknown metric' },
      { id: 3, claim: 'c3', deadline: null, spec: null },
    ],
    null,
  );
  assert.match(
    text,
    /3 open spec-less prediction\(s\): 1 proposed, 1 rejected by validation, 1 left/,
  );
  assert.match(text, /#2 REJECTED: unknown metric/);
  assert.match(text, /Dry run — nothing written/);
  assert.match(proposalsText([], 0), /Applied: 0/);
});
