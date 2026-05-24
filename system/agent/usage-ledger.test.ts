import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RobinDb } from '../brain/memory/db.ts';
import { migration011 } from '../brain/memory/migrations/011-agent-usage.ts';
import { UsageLedger } from './usage-ledger.ts';

function db(): RobinDb {
  const d = new Database(':memory:') as unknown as RobinDb;
  migration011.up(d);
  return d;
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
