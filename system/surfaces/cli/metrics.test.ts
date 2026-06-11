import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { agentMetricsRows, agentMetricsText } from './metrics.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cli-metrics-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function insertRun(
  db: ReturnType<typeof freshDb>,
  opts: {
    label?: string | null;
    surface?: string;
    outcome?: string | null;
    verified?: string | null;
    costUsd?: number;
    status?: string | null;
    ts?: string;
  },
) {
  const ts = opts.ts ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_usage (ts, surface, label, cost_usd, turns, input_tokens, output_tokens, status, outcome, verified)
     VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, ?)`,
  ).run(
    ts,
    opts.surface ?? 'agentic-autonomous',
    opts.label ?? null,
    opts.costUsd ?? 0.01,
    opts.status ?? null,
    opts.outcome ?? null,
    opts.verified ?? null,
  );
}

test('agentMetricsRows aggregates per handler label', () => {
  const db = freshDb();

  // Handler B: 3 runs
  //   run 1: did-work + verified
  insertRun(db, { label: 'B', outcome: 'did-work', verified: 'verified', costUsd: 0.1 });
  //   run 2: did-work + outcome-mismatch
  insertRun(db, {
    label: 'B',
    outcome: 'did-work',
    verified: 'outcome-mismatch',
    costUsd: 0.05,
    ts: new Date(Date.now() - 1000).toISOString(),
  });
  //   run 3: status='error', outcome=null (legacy-ish error row)
  insertRun(db, { label: 'B', outcome: null, status: 'error', costUsd: 0.02 });

  // Handler D: 1 run, no-op
  insertRun(db, { label: 'D', outcome: 'no-op', costUsd: 0.01 });

  // Legacy row — label NULL — must be ignored
  insertRun(db, { label: null, outcome: 'did-work', costUsd: 0.99 });

  // Non-agentic surface row with label X — must be ignored
  insertRun(db, { label: 'X', surface: 'llm', outcome: 'did-work', costUsd: 0.5 });

  const rows = agentMetricsRows(db);

  // Only B and D returned (X filtered by surface, null filtered by label IS NOT NULL)
  assert.equal(rows.length, 2, `expected 2 rows, got ${rows.length}`);

  const b = rows.find((r) => r.label === 'B');
  const d = rows.find((r) => r.label === 'D');

  assert.ok(b, 'missing B row');
  assert.ok(d, 'missing D row');

  // B runs
  assert.equal(b.runs, 3);
  // B cost: 0.10 + 0.05 + 0.02 = 0.17
  assert.ok(Math.abs(b.costUsd - 0.17) < 0.0001, `B costUsd expected ~0.17 got ${b.costUsd}`);
  // B did-work count
  assert.equal(b.didWork, 2);
  // B verified
  assert.equal(b.verified, 1);
  // B mismatches
  assert.equal(b.mismatches, 1);
  // B noOp
  assert.equal(b.noOp, 0);
  // B lastDidWork should be non-null (has did-work rows)
  assert.ok(b.lastDidWork !== null, 'B lastDidWork should not be null');

  // D assertions
  assert.equal(d.runs, 1);
  assert.equal(d.noOp, 1);
  assert.equal(d.didWork, 0);
  assert.equal(d.lastDidWork, null, 'D has no did-work rows');

  closeDb(db);
});

test('agentMetricsText renders a line per handler and totals', () => {
  const db = freshDb();

  insertRun(db, { label: 'B', outcome: 'did-work', verified: 'verified', costUsd: 0.1 });
  insertRun(db, { label: 'D', outcome: 'no-op', costUsd: 0.01 });

  const text = agentMetricsText(db);

  assert.ok(text.includes('B'), 'missing B in output');
  assert.ok(text.includes('D'), 'missing D in output');
  assert.ok(text.includes('runs:'), 'missing runs: label');
  assert.ok(text.includes('did-work:'), 'missing did-work: label');
  assert.ok(text.includes('total:'), 'missing totals line');
  // Total line should show 2 runs
  assert.ok(text.includes('2 runs'), `expected '2 runs' in totals, got: ${text}`);

  closeDb(db);
});

test('agentMetricsText says no runs when the ledger is empty', () => {
  const db = freshDb();
  const text = agentMetricsText(db);
  assert.equal(text, 'No labeled agent runs recorded yet.');
  closeDb(db);
});
