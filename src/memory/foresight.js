// foresight.js — predictions and calibration (memos kind='prediction').
// Spec §5. New module consolidating prediction logic previously scattered
// across CLI and MCP handlers.

import { BoundQuery } from 'surrealdb';
import * as store from './store.js';

/**
 * Record an agent-emitted prediction.
 */
export async function predict(db, embedder, { statement, statement_kind, confidence, expected_resolution_at }) {
  if (!statement) throw new Error('foresight.predict: statement required');
  if (!statement_kind) throw new Error('foresight.predict: statement_kind required');
  if (
    typeof confidence !== 'number' ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error('foresight.predict: confidence must be a number in [0,1]');
  }
  const meta = { statement_kind };
  if (expected_resolution_at) {
    meta.expected_resolution_at = new Date(expected_resolution_at);
  }
  return store.note(db, embedder, 'prediction', {
    content: statement,
    confidence,
    derived_by: 'manual',
    meta,
  });
}

/**
 * Resolve a prediction with the actual outcome.
 */
export async function resolve(db, id, { correct, actual_outcome }) {
  if (typeof correct !== 'boolean') {
    throw new Error('foresight.resolve: correct must be a boolean');
  }
  const patch = { resolved_at: new Date(), correct };
  if (actual_outcome) patch.actual_outcome = actual_outcome;
  await store.updateMemoMeta(db, id, patch);
}

/**
 * List currently-open predictions, optionally filtered by statement_kind or
 * by predicted-at age.
 */
export async function listOpen(db, { statement_kind, older_than_days } = {}) {
  const filters = ["kind = 'prediction'", 'meta.resolved_at IS NONE'];
  const bindings = {};
  if (statement_kind) {
    filters.push('meta.statement_kind = $sk');
    bindings.sk = statement_kind;
  }
  if (Number.isInteger(older_than_days) && older_than_days > 0) {
    bindings.cutoff = new Date(Date.now() - older_than_days * 86400_000);
    filters.push('derived_at < $cutoff');
  }
  const sql = `
    SELECT id, content AS statement, confidence, derived_at AS predicted_at, meta
    FROM memos
    WHERE ${filters.join(' AND ')}
    ORDER BY derived_at DESC
    LIMIT 50
  `;
  const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
  return rows.map((r) => ({
    id: r.id,
    statement: r.statement,
    kind: r.meta?.statement_kind,
    confidence: r.confidence,
    predicted_at: r.predicted_at,
    expected_resolution_at: r.meta?.expected_resolution_at,
  }));
}

/**
 * Compute per-(statement_kind) accuracy + open/resolved counts.
 * Used by dream/step-calibration to populate persona.calibration.
 */
export async function computeCalibration(db) {
  const [resolved] = await db
    .query(
      `SELECT meta.statement_kind AS kind, meta.correct AS correct
       FROM memos
       WHERE kind = 'prediction' AND meta.resolved_at IS NOT NONE`,
    )
    .collect();
  const [open] = await db
    .query(
      `SELECT count() AS n FROM memos
       WHERE kind = 'prediction' AND meta.resolved_at IS NONE
       GROUP ALL`,
    )
    .collect();

  const by_kind = {};
  for (const row of resolved ?? []) {
    const k = row.kind ?? 'unknown';
    if (!by_kind[k]) by_kind[k] = { correct: 0, total: 0 };
    by_kind[k].total += 1;
    if (row.correct === true) by_kind[k].correct += 1;
  }
  for (const k of Object.keys(by_kind)) {
    by_kind[k].accuracy = by_kind[k].total > 0 ? by_kind[k].correct / by_kind[k].total : null;
  }
  return {
    by_kind,
    total_resolved: resolved?.length ?? 0,
    total_open: open?.[0]?.n ?? 0,
  };
}
