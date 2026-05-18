// introspection-budget.test.js — unit tests for budget.js Wave 3 additions:
//   - tryReserveCost atomicity
//   - recordActualCost correction
//   - isStratumAllowed strata-priority logic
//   - autoTuneTurnSamplePct formula + cold-start default
//   - antecedent_regex_fallback flag

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import {
  autoTuneTurnSamplePct,
  isStratumAllowed,
  readBudgetState,
  recordActualCost,
  tryReserveCost,
} from '../../cognition/introspection/budget.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

// ── Test home setup ──────────────────────────────────────────────────────────
const HOME = join(tmpdir(), `robin-budget-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

const MIGRATIONS_PATH = resolve(import.meta.dirname, '../../data/db/migrations');

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, MIGRATIONS_PATH);
  return db;
}

/** Write both KV rows for budget. */
async function initBudget(db, { limit = 0.5, spent = 0, turn_sample_pct = 20 } = {}) {
  await db
    .query(
      `UPSERT runtime:\`introspection.config\` SET
         value.daily_cost_budget_usd = ${limit},
         value.turn_sample_pct_floor = 5,
         value.turn_sample_pct_ceiling = 50,
         value.target_turn_spend_fraction = 0.5,
         value.budget_remaining_thresholds.recall_throttle_at = 0.25,
         value.budget_remaining_thresholds.antecedent_regex_fallback_at = 0.25,
         value.budget_remaining_thresholds.turn_sample_cutoff_at = 0.10`,
    )
    .collect();
  await db
    .query(
      `UPSERT runtime:\`introspection.value\` SET
         value.daily_spend_usd = ${spent},
         value.turn_sample_pct = ${turn_sample_pct}`,
    )
    .collect();
}

// ── isStratumAllowed tests ───────────────────────────────────────────────────

const DEFAULT_CFG = {
  daily_cost_budget_usd: 0.5,
  turn_sample_pct_floor: 5,
  turn_sample_pct_ceiling: 50,
  target_turn_spend_fraction: 0.5,
  budget_remaining_thresholds: {
    recall_throttle_at: 0.25,
    antecedent_regex_fallback_at: 0.25,
    turn_sample_cutoff_at: 0.1,
  },
};

test('isStratumAllowed: predictions always allowed regardless of budget', () => {
  const exhausted = { daily_spend_usd: 0.5, turn_sample_pct: 20 };
  const result = isStratumAllowed('predictions', DEFAULT_CFG, exhausted);
  assert.equal(result.allowed, true);
});

test('isStratumAllowed: outbound allowed when budget remaining', () => {
  const state = { daily_spend_usd: 0.3, turn_sample_pct: 20 };
  assert.equal(isStratumAllowed('outbound', DEFAULT_CFG, state).allowed, true);
});

test('isStratumAllowed: outbound denied when budget exhausted', () => {
  const state = { daily_spend_usd: 0.5, turn_sample_pct: 20 };
  assert.equal(isStratumAllowed('outbound', DEFAULT_CFG, state).allowed, false);
});

test('isStratumAllowed: jobs allowed in throttle zone (budget > 0)', () => {
  // 20% remaining (< 25% recall_throttle_at but jobs are not recall).
  const state = { daily_spend_usd: 0.4, turn_sample_pct: 20 };
  assert.equal(isStratumAllowed('jobs', DEFAULT_CFG, state).allowed, true);
});

test('isStratumAllowed: recall 100% when above throttle threshold', () => {
  const state = { daily_spend_usd: 0.2, turn_sample_pct: 20 }; // 60% remaining
  const r = isStratumAllowed('recall', DEFAULT_CFG, state);
  assert.equal(r.allowed, true);
  assert.equal(r.samplePct, 100);
});

test('isStratumAllowed: recall throttled to 25% when <= 25% remaining', () => {
  const state = { daily_spend_usd: 0.38, turn_sample_pct: 20 }; // 24% remaining
  const r = isStratumAllowed('recall', DEFAULT_CFG, state);
  assert.equal(r.allowed, true);
  assert.equal(r.samplePct, 25);
});

test('isStratumAllowed: turns use turn_sample_pct from state', () => {
  const state = { daily_spend_usd: 0.3, turn_sample_pct: 35 }; // 40% remaining
  const r = isStratumAllowed('turns', DEFAULT_CFG, state);
  assert.equal(r.allowed, true);
  assert.equal(r.samplePct, 35);
});

test('isStratumAllowed: turns denied below 10% remaining', () => {
  const state = { daily_spend_usd: 0.46, turn_sample_pct: 20 }; // 8% remaining
  const r = isStratumAllowed('turns', DEFAULT_CFG, state);
  assert.equal(r.allowed, false);
});

// ── tryReserveCost tests ─────────────────────────────────────────────────────

test('tryReserveCost: succeeds when budget has room', async () => {
  const db = await fresh();
  await initBudget(db, { limit: 0.5, spent: 0.1 });

  const r = await tryReserveCost(db, 0.05);
  assert.equal(r.ok, true);
  assert.ok(typeof r.remaining === 'number');

  // Spend should have increased.
  const state = await readBudgetState(db);
  assert.ok(state.daily_spend_usd >= 0.15 - 1e-9);
  await close(db);
});

test('tryReserveCost: fails when budget exhausted', async () => {
  const db = await fresh();
  await initBudget(db, { limit: 0.5, spent: 0.5 });

  const r = await tryReserveCost(db, 0.01);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exhausted');
  await close(db);
});

test('tryReserveCost: two sequential calls both succeed when budget allows both', async () => {
  const db = await fresh();
  await initBudget(db, { limit: 0.5, spent: 0 });

  const r1 = await tryReserveCost(db, 0.1);
  const r2 = await tryReserveCost(db, 0.1);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);

  // Total spend should be ~0.20.
  const state = await readBudgetState(db);
  assert.ok(state.daily_spend_usd >= 0.2 - 1e-9);
  await close(db);
});

test('tryReserveCost: fails on second call when combined cost exceeds limit', async () => {
  const db = await fresh();
  await initBudget(db, { limit: 0.5, spent: 0.45 });

  // First call uses 0.04 → total 0.49, ok.
  const r1 = await tryReserveCost(db, 0.04);
  assert.equal(r1.ok, true);

  // Second call uses 0.04 → total 0.53 > 0.50, fails.
  const r2 = await tryReserveCost(db, 0.04);
  assert.equal(r2.ok, false);
  await close(db);
});

// ── recordActualCost tests ───────────────────────────────────────────────────

test('recordActualCost: adjusts spend when actual > estimated', async () => {
  const db = await fresh();
  await initBudget(db, { limit: 0.5, spent: 0.1 });

  // Estimated 0.01 was reserved; actual was 0.02 → record +0.01 delta.
  await recordActualCost(db, 0.02, 0.01);

  const state = await readBudgetState(db);
  // Spend should reflect the adjustment (0.10 + 0.01 delta = 0.11).
  assert.ok(state.daily_spend_usd >= 0.11 - 1e-9);
  await close(db);
});

test('recordActualCost: adjusts spend when actual < estimated (credit)', async () => {
  const db = await fresh();
  await initBudget(db, { limit: 0.5, spent: 0.2 });

  // Estimated 0.05, actual 0.03 → record -0.02 delta.
  await recordActualCost(db, 0.03, 0.05);

  const state = await readBudgetState(db);
  // Spend should decrease by 0.02.
  assert.ok(state.daily_spend_usd <= 0.18 + 1e-9);
  await close(db);
});

// ── autoTuneTurnSamplePct tests ──────────────────────────────────────────────

test('autoTuneTurnSamplePct: cold start returns 20 (no history)', async () => {
  const db = await fresh();
  await initBudget(db, { limit: 0.5, spent: 0.1 });

  const cfg = {
    daily_cost_budget_usd: 0.5,
    turn_sample_pct_floor: 5,
    turn_sample_pct_ceiling: 50,
    target_turn_spend_fraction: 0.5,
    budget_remaining_thresholds: {
      recall_throttle_at: 0.25,
      antecedent_regex_fallback_at: 0.25,
      turn_sample_cutoff_at: 0.1,
    },
  };

  const pct = await autoTuneTurnSamplePct(db, cfg);
  // Cold start: floor(20) clamped to [5, 50] = 20.
  assert.equal(pct, 20);
  await close(db);
});

test('autoTuneTurnSamplePct: persists result to runtime:introspection.value', async () => {
  const db = await fresh();
  await initBudget(db, { limit: 0.5, spent: 0 });

  const cfg = {
    daily_cost_budget_usd: 0.5,
    turn_sample_pct_floor: 5,
    turn_sample_pct_ceiling: 50,
    target_turn_spend_fraction: 0.5,
    budget_remaining_thresholds: {
      recall_throttle_at: 0.25,
      antecedent_regex_fallback_at: 0.25,
      turn_sample_cutoff_at: 0.1,
    },
  };

  const pct = await autoTuneTurnSamplePct(db, cfg);
  const state = await readBudgetState(db);
  assert.equal(state.turn_sample_pct, pct, 'persisted turn_sample_pct matches returned value');
  await close(db);
});

test('autoTuneTurnSamplePct: antecedent_regex_fallback=true when budget < 25%', async () => {
  const db = await fresh();
  // 20% remaining → below 25% recall_throttle_at.
  await initBudget(db, { limit: 0.5, spent: 0.41 });

  const cfg = {
    daily_cost_budget_usd: 0.5,
    turn_sample_pct_floor: 5,
    turn_sample_pct_ceiling: 50,
    target_turn_spend_fraction: 0.5,
    budget_remaining_thresholds: {
      recall_throttle_at: 0.25,
      antecedent_regex_fallback_at: 0.25,
      turn_sample_cutoff_at: 0.1,
    },
  };

  await autoTuneTurnSamplePct(db, cfg);

  // Read value row directly to check antecedent_regex_fallback.
  const [rows] = await db
    .query(`SELECT VALUE value FROM runtime:\`introspection.value\``)
    .collect();
  const v = Array.isArray(rows) ? rows[0] : rows;
  assert.equal(v?.antecedent_regex_fallback, true, 'flag set when budget < 25%');
  await close(db);
});

test('autoTuneTurnSamplePct: antecedent_regex_fallback=false when budget > 25%', async () => {
  const db = await fresh();
  // 60% remaining → above 25%.
  await initBudget(db, { limit: 0.5, spent: 0.2 });

  const cfg = {
    daily_cost_budget_usd: 0.5,
    turn_sample_pct_floor: 5,
    turn_sample_pct_ceiling: 50,
    target_turn_spend_fraction: 0.5,
    budget_remaining_thresholds: {
      recall_throttle_at: 0.25,
      antecedent_regex_fallback_at: 0.25,
      turn_sample_cutoff_at: 0.1,
    },
  };

  await autoTuneTurnSamplePct(db, cfg);

  const [rows] = await db
    .query(`SELECT VALUE value FROM runtime:\`introspection.value\``)
    .collect();
  const v = Array.isArray(rows) ? rows[0] : rows;
  assert.equal(v?.antecedent_regex_fallback, false, 'flag clear when budget > 25%');
  await close(db);
});

test('autoTuneTurnSamplePct: with 7d history, formula produces clamped value', async () => {
  const db = await fresh();
  await initBudget(db, { limit: 0.5, spent: 0 });

  // Seed 7 graded turn memos with known cost (simulating 7d of 1/day turns at $0.001 each).
  // projected_turn_cost = 0.001 * (7/7) = 0.001
  // target_turn_spend = 0.50 * 0.5 = 0.25
  // turn_sample_pct = round(0.25 / 0.001 * 100) = 25000 → clamped to ceiling=50
  const past8d = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  for (let i = 0; i < 7; i++) {
    const dt = new Date(past8d.getTime() + i * 24 * 60 * 60 * 1000);
    await db
      .query(
        surql`CREATE memos SET
           kind = 'task_outcome',
           content = 'test',
           content_hash = ${String(i)},
           derived_by = 'introspection',
           derived_at = ${dt},
           meta = ${{
             task_type: 'turn:default',
             score: 0.7,
             signals: {
               self_grade: {
                 cost_usd: 0.001,
                 completeness: 0.7,
                 correction_likelihood: 0.3,
                 model: 'claude-haiku-4-5',
                 ts: dt.toISOString(),
               },
             },
           }},
           scope = 'global',
           tags = []`,
      )
      .collect();
  }

  const cfg = {
    daily_cost_budget_usd: 0.5,
    turn_sample_pct_floor: 5,
    turn_sample_pct_ceiling: 50,
    target_turn_spend_fraction: 0.5,
    budget_remaining_thresholds: {
      recall_throttle_at: 0.25,
      antecedent_regex_fallback_at: 0.25,
      turn_sample_cutoff_at: 0.1,
    },
  };

  const pct = await autoTuneTurnSamplePct(db, cfg);
  // Formula yields very high number → clamped to ceiling 50.
  assert.equal(pct, 50, 'clamped to ceiling when projected cost is tiny');
  await close(db);
});
