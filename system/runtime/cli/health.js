// src/cli/health.js — Theme 4. Lazy rollups for `robin doctor --health`.

import { surql } from 'surrealdb';
import { currentBudget, readCadenceConfig } from '../../cognition/dream/budget.js';

async function readDoctorConfig(db) {
  try {
    const [rows] = await db.query('SELECT VALUE value FROM runtime:`doctor.config`').collect();
    return (
      rows?.[0] ?? {
        budget_warn_pct: 0.85,
        budget_fail_pct: 0.98,
        pending_triggers_warn: 50,
        faculty_error_rate_warn: 0.01,
        faculty_error_rate_fail: 0.05,
        stale_dream_warn_hours: 30,
      }
    );
  } catch {
    return {
      budget_warn_pct: 0.85,
      budget_fail_pct: 0.98,
      pending_triggers_warn: 50,
      faculty_error_rate_warn: 0.01,
      faculty_error_rate_fail: 0.05,
      stale_dream_warn_hours: 30,
    };
  }
}

export async function rollupTokenBudget(db) {
  const cfg = await readDoctorConfig(db);
  const cadenceCfg = await readCadenceConfig(db);
  const budget = await currentBudget(db, cadenceCfg ?? {});
  const pct = budget.daily === 0 ? 0 : budget.consumed / budget.daily;
  let status = 'ok';
  if (pct >= cfg.budget_fail_pct) status = 'fail';
  else if (pct >= cfg.budget_warn_pct) status = 'warn';
  return { consumed: budget.consumed, daily: budget.daily, pct, status };
}

export async function rollupFacultyErrors(db, hours = 7 * 24) {
  let rows = [];
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
  } catch {}
  const cfg = await readDoctorConfig(db);
  return rows.map((r) => {
    const rate = r.n === 0 ? 0 : (r.errors ?? 0) / r.n;
    let status = 'ok';
    if (rate >= cfg.faculty_error_rate_fail) status = 'fail';
    else if (rate >= cfg.faculty_error_rate_warn) status = 'warn';
    return { step: r.step, n: r.n, errors: r.errors ?? 0, rate, status };
  });
}

export async function rollupPendingTriggers(db) {
  const cfg = await readDoctorConfig(db);
  let count = 0;
  try {
    const [r] = await db
      .query(surql`SELECT count() AS n FROM dream_triggers WHERE processed_at IS NONE GROUP ALL`)
      .collect();
    count = r?.[0]?.n ?? 0;
  } catch {}
  return { count, status: count >= cfg.pending_triggers_warn ? 'warn' : 'ok' };
}

export async function rollupStaleDream(db) {
  const cfg = await readDoctorConfig(db);
  let lastRun = null;
  try {
    const [r] = await db
      .query(surql`SELECT value.last_run_at_success AS ts FROM runtime:dream`)
      .collect();
    lastRun = r?.[0]?.ts ?? null;
  } catch {}
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

export function aggregateExitCode(rollups) {
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
  const [budget, faculties, pending, dream, pendingRecallLog] = await Promise.all([
    rollupTokenBudget(db),
    rollupFacultyErrors(db),
    rollupPendingTriggers(db),
    rollupStaleDream(db),
    rollupPendingRecallLog(db),
  ]);
  const all = [budget, ...faculties, pending, dream, pendingRecallLog];
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
  lines.push('Faculty error rate (7d):');
  for (const f of faculties) {
    lines.push(`  ${String(f.step).padEnd(20)} ${GLYPH[f.status]} ${f.errors}/${f.n} errors`);
  }
  return { output: lines.join('\n'), exitCode };
}
