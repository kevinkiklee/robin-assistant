// cadence-consumer.js — heartbeat phase that drains dream_triggers, dispatches
// eligible steps, enforces caps and daily token budget. Theme 3.

import { BoundQuery, surql } from 'surrealdb';
import { currentBudget, estimateStepCost, readCadenceConfig } from '../../cognition/dream/budget.js';
import { advanceCursor, getCursor } from '../../cognition/dream/cursors.js';
import { dispatchStep } from '../../cognition/dream/dispatch.js';

async function mark(db, id, outcome, reason) {
  const set = reason
    ? surql`UPDATE ${id} SET processed_at = time::now(), outcome = ${outcome}, meta.cap_reason = ${reason}`
    : surql`UPDATE ${id} SET processed_at = time::now(), outcome = ${outcome}`;
  try {
    await db.query(set).collect();
  } catch (e) {
    console.warn(`[cadence] mark failed for ${id}: ${e.message}`);
  }
}

async function countSince(db, step, deltaMs) {
  const cutoff = new Date(Date.now() - deltaMs);
  try {
    const [rows] = await db
      .query(
        surql`SELECT count() AS n FROM cadence_telemetry
              WHERE step = ${step} AND success = true AND ts > ${cutoff} GROUP ALL`,
      )
      .collect();
    return rows?.[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

export async function consumePendingTriggers(db, host) {
  const cfg = await readCadenceConfig(db);
  if (!cfg?.trigger_consumer_enabled) return { skipped: 'disabled' };

  const budget = await currentBudget(db, cfg);
  if (budget.remaining <= 0) return { skipped: 'budget_exceeded' };

  // Expire stale pending
  try {
    await db
      .query(
        surql`UPDATE dream_triggers SET processed_at = time::now(), outcome = 'expired'
              WHERE processed_at IS NONE AND requested_at < time::now() - ${cfg.trigger_ttl_days}d`,
      )
      .collect();
  } catch {}

  const batchSize = cfg.consume_batch_size ?? 20;
  const [pending] = await db
    .query(
      surql`SELECT * FROM dream_triggers WHERE processed_at IS NONE
            ORDER BY requested_at ASC LIMIT ${batchSize}`,
    )
    .collect();

  const summary = { processed: 0, ran: 0, debounced: 0, capped: 0, budget_exceeded: 0, error: 0 };

  for (const trig of pending ?? []) {
    summary.processed++;
    const stepCfg = cfg.steps?.[trig.step];
    if (!stepCfg?.trigger_eligible) {
      await mark(db, trig.id, 'capped', 'not_trigger_eligible');
      summary.capped++;
      continue;
    }
    const debounced = await countSince(db, trig.step, stepCfg.debounce_minutes * 60_000);
    if (debounced > 0) {
      await mark(db, trig.id, 'debounced');
      summary.debounced++;
      continue;
    }
    const hourly = await countSince(db, trig.step, 60 * 60_000);
    if (hourly >= stepCfg.max_per_hour) {
      await mark(db, trig.id, 'capped', 'hourly');
      summary.capped++;
      continue;
    }
    const daily = await countSince(db, trig.step, 24 * 60 * 60_000);
    if (daily >= stepCfg.max_per_day) {
      await mark(db, trig.id, 'capped', 'daily');
      summary.capped++;
      continue;
    }
    const estCost = await estimateStepCost(db, trig.step);
    if (estCost > budget.remaining) {
      await mark(db, trig.id, 'budget_exceeded');
      summary.budget_exceeded++;
      continue;
    }
    const cursor = await getCursor(db, trig.step);
    const start = Date.now();
    try {
      const result = await dispatchStep(db, host, trig.step, { since: cursor });
      if (result.processed_until)
        await advanceCursor(db, trig.step, new Date(result.processed_until));
      const used = (result.tokens_in ?? 0) + (result.tokens_out ?? 0);
      await db
        .query(
          new BoundQuery(
            `CREATE cadence_telemetry CONTENT {
              step: $step, trigger_id: $tid,
              tokens_in: $ti, tokens_out: $to,
              duration_ms: $dur, success: true
            }`,
            {
              step: trig.step,
              tid: trig.id,
              ti: result.tokens_in ?? 0,
              to: result.tokens_out ?? 0,
              dur: Date.now() - start,
            },
          ),
        )
        .collect();
      await mark(db, trig.id, 'ran');
      summary.ran++;
      budget.remaining -= used;
      if (budget.remaining <= 0) break;
    } catch (e) {
      await db
        .query(
          new BoundQuery(
            `CREATE cadence_telemetry CONTENT {
              step: $step, trigger_id: $tid,
              duration_ms: $dur, success: false, error: $err
            }`,
            { step: trig.step, tid: trig.id, dur: Date.now() - start, err: e.message },
          ),
        )
        .collect();
      await mark(db, trig.id, 'error');
      summary.error++;
    }
  }

  return summary;
}
