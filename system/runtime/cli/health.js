// src/cli/health.js — Theme 4. Lazy rollups for `robin doctor --health`.

import { surql } from 'surrealdb';
import { currentBudget, readCadenceConfig } from '../../cognition/dream/budget.js';

// Defaults applied when `runtime:doctor.config` is missing OR the query
// itself fails (DB closed, schema not yet migrated, etc.). Single source
// of truth — prior versions inlined this twice and drifted on edits.
const DEFAULT_DOCTOR_CONFIG = Object.freeze({
  budget_warn_pct: 0.85,
  budget_fail_pct: 0.98,
  pending_triggers_warn: 50,
  faculty_error_rate_warn: 0.01,
  faculty_error_rate_fail: 0.05,
  stale_dream_warn_hours: 30,
});

async function readDoctorConfig(db) {
  try {
    const [rows] = await db.query('SELECT VALUE value FROM runtime:`doctor.config`').collect();
    return rows?.[0] ?? DEFAULT_DOCTOR_CONFIG;
  } catch {
    return DEFAULT_DOCTOR_CONFIG;
  }
}

async function rollupTokenBudget(db) {
  const cfg = await readDoctorConfig(db);
  const cadenceCfg = await readCadenceConfig(db);
  const budget = await currentBudget(db, cadenceCfg ?? {});
  const pct = budget.daily === 0 ? 0 : budget.consumed / budget.daily;
  let status = 'ok';
  if (pct >= cfg.budget_fail_pct) status = 'fail';
  else if (pct >= cfg.budget_warn_pct) status = 'warn';
  return { consumed: budget.consumed, daily: budget.daily, pct, status };
}

async function rollupFacultyErrors(db, hours = 7 * 24) {
  const cfg = await readDoctorConfig(db);
  let rows;
  try {
    const [r] = await db
      .query(
        surql`SELECT step,
                     count() AS n,
                     math::sum(IF success THEN 0 ELSE 1 END) AS errors
              FROM cadence_telemetry
              WHERE ts > time::now() - ${hours}h
              GROUP BY step`,
      )
      .collect();
    rows = r ?? [];
  } catch (e) {
    // Surface the query failure as a single "faculty rollup" fail row so the
    // operator sees that the section is broken rather than silently
    // rendering an empty/clean faculty list.
    return [{ step: 'faculty_rollup', n: 0, errors: 0, rate: 0, status: 'fail', error: e.message }];
  }
  return rows.map((r) => {
    const rate = r.n === 0 ? 0 : (r.errors ?? 0) / r.n;
    let status = 'ok';
    if (rate >= cfg.faculty_error_rate_fail) status = 'fail';
    else if (rate >= cfg.faculty_error_rate_warn) status = 'warn';
    return { step: r.step, n: r.n, errors: r.errors ?? 0, rate, status };
  });
}

async function rollupPendingTriggers(db) {
  const cfg = await readDoctorConfig(db);
  try {
    const [r] = await db
      .query(surql`SELECT count() AS n FROM dream_triggers WHERE processed_at IS NONE GROUP ALL`)
      .collect();
    const count = r?.[0]?.n ?? 0;
    return { count, status: count >= cfg.pending_triggers_warn ? 'warn' : 'ok' };
  } catch (e) {
    // Surface query failure rather than reporting count=0 + status=ok, which
    // would falsely indicate a healthy trigger queue.
    return { count: 0, status: 'fail', error: e.message };
  }
}

async function rollupStaleDream(db) {
  const cfg = await readDoctorConfig(db);
  let lastRun;
  try {
    const [r] = await db
      .query(surql`SELECT value.last_run_at_success AS ts FROM runtime:dream`)
      .collect();
    lastRun = r?.[0]?.ts ?? null;
  } catch (e) {
    // Query failure is distinct from "never ran" — surface both, but only the
    // former carries an error string.
    return { hours_since: null, status: 'fail', error: e.message };
  }
  if (!lastRun) return { hours_since: null, status: 'warn' };
  const hours = (Date.now() - new Date(lastRun).getTime()) / 3_600_000;
  return { hours_since: hours, status: hours >= cfg.stale_dream_warn_hours ? 'warn' : 'ok' };
}

const PENDING_RECALL_LOG_WARN_THRESHOLD = 100;
const PENDING_RECALL_LOG_AGE_DAYS = 7;

export async function rollupPendingRecallLog(db) {
  const cutoff = new Date(Date.now() - PENDING_RECALL_LOG_AGE_DAYS * 86_400_000);
  try {
    const [rows] = await db
      .query(
        surql`SELECT count() AS n
              FROM recall_log
              WHERE outcome = 'pending' AND ts < ${cutoff}
              GROUP ALL`,
      )
      .collect();
    const count = rows?.[0]?.n ?? 0;
    return {
      step: 'pending_recall_log',
      count,
      threshold: PENDING_RECALL_LOG_WARN_THRESHOLD,
      age_days: PENDING_RECALL_LOG_AGE_DAYS,
      status: count > PENDING_RECALL_LOG_WARN_THRESHOLD ? 'warn' : 'ok',
    };
  } catch (e) {
    return {
      step: 'pending_recall_log',
      count: 0,
      threshold: PENDING_RECALL_LOG_WARN_THRESHOLD,
      age_days: PENDING_RECALL_LOG_AGE_DAYS,
      status: 'fail',
      error: e.message,
    };
  }
}

// Cognition D1 — state-inference health rollup.
// Writes/24h, avg confidence, errors/1h. Exit-code thresholds: ≥1 err/1h →
// warn (rollups returning 'warn' bump aggregate to 1); ≥3 err/1h → fail (2).
export async function rollupStateInference(db) {
  let writes_24h = 0;
  let avg_conf = null;
  let errors_1h = 0;
  let queryError = null;
  try {
    const [r] = await db
      .query(
        surql`SELECT count() AS n, math::mean(confidence) AS c
              FROM memos
              WHERE kind = 'state_inference'
                AND derived_at > time::now() - 24h`,
      )
      .collect();
    writes_24h = r?.[0]?.n ?? 0;
    avg_conf = r?.[0]?.c ?? null;
  } catch (e) {
    queryError = e.message;
  }
  try {
    const [r] = await db
      .query(
        surql`SELECT count() AS n FROM state_inference_telemetry
              WHERE outcome = 'error' AND ts > time::now() - 1h GROUP ALL`,
      )
      .collect();
    errors_1h = r?.[0]?.n ?? 0;
  } catch (e) {
    queryError = queryError ?? e.message;
  }
  let status = 'ok';
  if (queryError) status = 'fail';
  else if (errors_1h >= 3) status = 'fail';
  else if (errors_1h >= 1) status = 'warn';
  const out = { writes_24h, avg_conf, errors_1h, status };
  if (queryError) out.error = queryError;
  return out;
}

function aggregateExitCode(rollups) {
  for (const r of rollups) {
    if (r?.status === 'fail') return 2;
  }
  for (const r of rollups) {
    if (r?.status === 'warn') return 1;
  }
  return 0;
}

const GLYPH = { ok: '✓', warn: '⚠', fail: '✗' };

export async function runHealth(db, { json = false } = {}) {
  const [budget, faculties, pending, dream, pendingRecallLog, stateInference] = await Promise.all([
    rollupTokenBudget(db),
    rollupFacultyErrors(db),
    rollupPendingTriggers(db),
    rollupStaleDream(db),
    rollupPendingRecallLog(db),
    rollupStateInference(db),
  ]);
  const all = [budget, ...faculties, pending, dream, pendingRecallLog, stateInference];
  const exitCode = aggregateExitCode(all);
  if (json) {
    return {
      output: JSON.stringify(
        {
          ts: new Date().toISOString(),
          budget,
          faculties,
          pending,
          dream,
          pending_recall_log: pendingRecallLog,
          state_inference: stateInference,
          exit_code: exitCode,
        },
        null,
        2,
      ),
      exitCode,
    };
  }
  const lines = [];
  lines.push(`=== Robin health · ${new Date().toISOString().slice(0, 10)} ===`);
  lines.push(
    `Token budget:        ${GLYPH[budget.status]} ${Math.round((budget.consumed ?? 0) / 1000)}k / ${Math.round((budget.daily ?? 0) / 1000)}k used (${Math.round((budget.pct ?? 0) * 100)}%)`,
  );
  lines.push(`Pending triggers:    ${GLYPH[pending.status]} ${pending.count}`);
  lines.push(
    `Pending recall_log >7d: ${GLYPH[pendingRecallLog.status]} ${pendingRecallLog.count} (>${pendingRecallLog.threshold} indicates stuck reinforcement)`,
  );
  lines.push(
    `Dream nightly:       ${GLYPH[dream.status]} ${dream.hours_since == null ? 'never' : `${Math.round(dream.hours_since)}h ago`}`,
  );
  lines.push(
    `State inference (24h): ${GLYPH[stateInference.status]} ${stateInference.writes_24h} writes, ${stateInference.avg_conf == null ? '—' : `avg conf ${stateInference.avg_conf.toFixed(2)}`}, ${stateInference.errors_1h} errs/1h`,
  );
  lines.push('Faculty error rate (7d):');
  for (const f of faculties) {
    lines.push(`  ${String(f.step).padEnd(20)} ${GLYPH[f.status]} ${f.errors}/${f.n} errors`);
  }
  return { output: lines.join('\n'), exitCode };
}
