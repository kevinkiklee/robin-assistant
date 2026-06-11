import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RobinDb } from '../brain/memory/db.ts';
import { migration011 } from '../brain/memory/migrations/011-agent-usage.ts';
import { migration025 } from '../brain/memory/migrations/025-agent-outcomes.ts';
import { UsageLedger } from './usage-ledger.ts';

function makeDb(): RobinDb {
  const d = new Database(':memory:') as unknown as RobinDb;
  migration011.up(d);
  migration025.up(d);
  return d;
}

/** Legacy helper kept for the three existing tests that don't need outcome columns. */
function db(): RobinDb {
  return makeDb();
}

test('record + dailyTotal per surface (UTC day)', () => {
  const led = new UsageLedger(db());
  led.record({
    surface: 'agentic-on-demand',
    costUsd: 1.5,
    inputTokens: 10,
    outputTokens: 2,
    turns: 1,
    status: 'success',
  });
  led.record({
    surface: 'agentic-autonomous',
    costUsd: 0.5,
    inputTokens: 5,
    outputTokens: 1,
    turns: 1,
    status: 'success',
  });
  assert.equal(led.dailyTotalUsd('agentic-on-demand'), 1.5);
  assert.equal(led.dailyTotalUsd('agentic-autonomous'), 0.5);
});

test('overCap is true once surface daily sum >= cap', () => {
  const led = new UsageLedger(db());
  led.record({
    surface: 'agentic-autonomous',
    costUsd: 25,
    inputTokens: 1,
    outputTokens: 1,
    turns: 1,
    status: 'success',
  });
  assert.equal(led.overCap('agentic-autonomous', 25), true);
  assert.equal(led.overCap('agentic-autonomous', 50), false);
});

test('todayBySurface sums cost + turns grouped by surface', () => {
  const led = new UsageLedger(db());
  led.record({
    surface: 'agentic-on-demand',
    costUsd: 1.5,
    inputTokens: 10,
    outputTokens: 2,
    turns: 2,
    status: 'success',
  });
  led.record({
    surface: 'agentic-on-demand',
    costUsd: 0.5,
    inputTokens: 4,
    outputTokens: 1,
    turns: 1,
    status: 'success',
  });
  led.record({
    surface: 'agentic-autonomous',
    costUsd: 0.25,
    inputTokens: 2,
    outputTokens: 1,
    turns: 1,
    status: 'success',
  });
  const bySurface = led.todayBySurface();
  assert.equal(bySurface['agentic-on-demand']?.costUsd, 2);
  assert.equal(bySurface['agentic-on-demand']?.turns, 3);
  assert.equal(bySurface['agentic-on-demand']?.runs, 2);
  assert.equal(bySurface['agentic-autonomous']?.costUsd, 0.25);
  assert.equal(bySurface['agentic-autonomous']?.runs, 1);
});

test('record() returns the inserted row id', () => {
  const database = makeDb();
  const ledger = new UsageLedger(database);
  const id = ledger.record({ surface: 's', costUsd: 1, inputTokens: 1, outputTokens: 1, turns: 1 });
  assert.equal(typeof id, 'number');
  assert.ok(id > 0);
});

test('recordOutcome() stamps outcome columns on an existing row', () => {
  const database = makeDb();
  const ledger = new UsageLedger(database);
  const id = ledger.record({
    surface: 's',
    costUsd: 1,
    inputTokens: 1,
    outputTokens: 1,
    turns: 1,
    label: 'B',
  });
  ledger.recordOutcome(id, {
    outcome: 'did-work',
    impact: 'medium',
    structuredJson: '{"outcome":"did-work"}',
    verified: 'verified',
  });
  const row = database
    .prepare('SELECT outcome, impact, structured_json, verified FROM agent_usage WHERE id=?')
    .get(id) as Record<string, string>;
  assert.equal(row.outcome, 'did-work');
  assert.equal(row.impact, 'medium');
  assert.equal(row.verified, 'verified');
});

test('recordOutcome() with partial fields leaves the rest NULL', () => {
  const database = makeDb();
  const ledger = new UsageLedger(database);
  const id = ledger.record({ surface: 's', costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 });
  ledger.recordOutcome(id, { outcome: 'unparseable' });
  const row = database
    .prepare('SELECT outcome, impact, verified FROM agent_usage WHERE id=?')
    .get(id) as Record<string, string | null>;
  assert.equal(row.outcome, 'unparseable');
  assert.equal(row.impact, null);
  assert.equal(row.verified, null);
});
