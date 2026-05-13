// budget.js — daily token budget enforcement for triggered cognition. Theme 3.

import { surql } from 'surrealdb';

const DEFAULT_BASELINE = 100_000;
const DEFAULT_PER_STEP = 2_000;

export async function readCadenceConfig(db) {
  try {
    const [rows] = await db.query('SELECT VALUE value FROM runtime:`cadence.config`').collect();
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

async function deriveBaselineBudget(db) {
  try {
    const [rows] = await db
      .query(
        surql`SELECT time::group(ts, 'day') AS day,
                     math::sum(tokens_in + tokens_out) AS daily_total
              FROM cadence_telemetry
              WHERE ts > time::now() - 7d
              GROUP BY day`,
      )
      .collect();
    const totals = (rows ?? []).map((r) => r.daily_total ?? 0).sort((a, b) => a - b);
    if (totals.length === 0) return DEFAULT_BASELINE;
    return totals[Math.floor(totals.length / 2)] || DEFAULT_BASELINE;
  } catch {
    return DEFAULT_BASELINE;
  }
}

export async function estimateStepCost(db, step) {
  try {
    const [rows] = await db
      .query(
        surql`SELECT VALUE (tokens_in + tokens_out) FROM cadence_telemetry
              WHERE step = ${step} AND success = true
              ORDER BY ts DESC LIMIT 10`,
      )
      .collect();
    const list = rows ?? [];
    if (!list.length) return DEFAULT_PER_STEP;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || DEFAULT_PER_STEP;
  } catch {
    return DEFAULT_PER_STEP;
  }
}

export async function currentBudget(db, cfg) {
  const daily =
    cfg?.daily_token_budget > 0 ? cfg.daily_token_budget : await deriveBaselineBudget(db);
  const safe = daily * (1 - (cfg?.budget_safety_margin ?? 0.2));
  let consumed = 0;
  try {
    const [used] = await db
      .query(
        surql`SELECT VALUE math::sum(tokens_in + tokens_out) FROM cadence_telemetry
              WHERE ts > time::now() - 24h GROUP ALL`,
      )
      .collect();
    consumed = used?.[0] ?? 0;
  } catch {}
  return { daily: safe, consumed, remaining: Math.max(0, safe - consumed) };
}
