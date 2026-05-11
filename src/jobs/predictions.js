// src/jobs/predictions.js
//
// Redesigned for the new schema: predictions are now memos with `kind='prediction'`.
// External call sites (predict / resolve_prediction / list_open_predictions
// MCP tools, daemon, dream/step-calibration, CLI list/show commands) keep
// their existing signatures; the body delegates to `src/memory/foresight.js`
// for the new code path, or queries `memos WHERE kind='prediction'` directly
// for the read helpers `foresight.js` doesn't expose.
//
// Calibration storage migrated from `profile:singleton` → `persona:singleton`
// (table renamed in the redesign; `persona.js` is the canonical writer).

import { BoundQuery, RecordId, surql } from 'surrealdb';
import * as foresight from '../memory/foresight.js';
import { updateCalibration } from '../memory/persona.js';

/**
 * Record an agent-emitted prediction. Now writes a memo row; previously
 * created a row in the deleted `predictions` table.
 *
 * NOTE: legacy callers pass `{statement, kind, confidence, expected_resolution_at}`.
 * `kind` maps to `meta.statement_kind` on the memo. A mock embedder is used
 * when no embedder is plumbed through — the embedding write is best-effort.
 */
export async function recordPrediction(
  db,
  { statement, kind, confidence, expected_resolution_at },
  { embedder } = {},
) {
  const eb = embedder ?? { embed: async () => new Float32Array(1024) };
  const result = await foresight.predict(db, eb, {
    statement,
    statement_kind: kind,
    confidence,
    expected_resolution_at,
  });
  return { id: String(result.id) };
}

/**
 * Resolve a prediction by id. Accepts the legacy `predictions:<id>` ref or a
 * bare id; rewrites to the memos record id.
 */
export async function resolvePrediction(db, { id, correct, actual_outcome }) {
  const memoId = await coerceMemoId(db, id);
  if (!memoId) return { ok: false, reason: 'not_found' };
  const existing = await getPrediction(db, memoId);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.resolved_at) return { ok: false, reason: 'already_resolved' };
  await foresight.resolve(db, memoId, { correct, actual_outcome });
  return { ok: true };
}

/**
 * Fetch a single prediction by id. Returns a flat shape mirroring the old
 * `predictions` row so existing callers keep working: `{id, statement, kind,
 * confidence, predicted_at, expected_resolution_at, resolved_at, correct,
 * actual_outcome}`.
 */
export async function getPrediction(db, id) {
  const memoId = await coerceMemoId(db, id);
  if (!memoId) return null;
  const [rows] = await db
    .query(
      surql`SELECT id, content, confidence, derived_at, meta
            FROM ${memoId}
            WHERE kind = 'prediction'`,
    )
    .collect();
  const row = rows?.[0];
  if (!row) return null;
  return projectPrediction(row);
}

export async function listOpenPredictions(db, { kind, older_than_days } = {}) {
  const filters = ["kind = 'prediction'", 'meta.resolved_at IS NONE'];
  const bindings = {};
  if (kind) {
    filters.push('meta.statement_kind = $kind');
    bindings.kind = kind;
  }
  if (older_than_days) {
    bindings.cutoff = new Date(Date.now() - older_than_days * 86_400_000);
    filters.push('derived_at < $cutoff');
  }
  const sql = `
    SELECT id, content, confidence, derived_at, meta
    FROM memos
    WHERE ${filters.join(' AND ')}
    ORDER BY derived_at DESC
  `;
  const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
  return (rows ?? []).map(projectPrediction);
}

export async function listAllPredictions(db, { kind, resolved } = {}) {
  const filters = ["kind = 'prediction'"];
  const bindings = {};
  if (kind) {
    filters.push('meta.statement_kind = $kind');
    bindings.kind = kind;
  }
  if (resolved === true) filters.push('meta.resolved_at IS NOT NONE');
  if (resolved === false) filters.push('meta.resolved_at IS NONE');
  const sql = `
    SELECT id, content, confidence, derived_at, meta
    FROM memos
    WHERE ${filters.join(' AND ')}
    ORDER BY derived_at DESC
  `;
  const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
  return (rows ?? []).map(projectPrediction);
}

export async function computeCalibration(db) {
  const fc = await foresight.computeCalibration(db);
  // Reshape to the legacy structure expected by step-calibration / CLI:
  // { by_kind: {<kind>: {resolved, correct, accuracy}}, total_open, total_resolved, last_computed_at }
  const by_kind = {};
  for (const [k, v] of Object.entries(fc.by_kind)) {
    by_kind[k] = {
      resolved: v.total,
      correct: v.correct,
      accuracy: v.accuracy ?? 0,
    };
  }
  return {
    by_kind,
    total_open: fc.total_open,
    total_resolved: fc.total_resolved,
    last_computed_at: new Date(),
  };
}

export async function setCalibration(db, calibration) {
  // Persona writer is the canonical entry; old `profile:singleton` is gone.
  await updateCalibration(db, calibration);
}

export async function getCalibration(db) {
  const [rows] = await db.query(surql`SELECT calibration FROM persona:singleton`).collect();
  return rows?.[0]?.calibration ?? null;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function projectPrediction(row) {
  if (!row) return null;
  const meta = row.meta ?? {};
  return {
    id: row.id,
    statement: row.content,
    kind: meta.statement_kind ?? null,
    confidence: row.confidence,
    predicted_at: row.derived_at,
    expected_resolution_at: meta.expected_resolution_at ?? null,
    resolved_at: meta.resolved_at ?? null,
    correct: meta.correct ?? null,
    actual_outcome: meta.actual_outcome ?? null,
  };
}

// Accept legacy `predictions:<id>` refs, raw memo refs, or string ids. Strip
// any obsolete `predictions:` prefix and resolve to the matching memo RecordId.
async function coerceMemoId(db, id) {
  if (!id) return null;
  if (typeof id !== 'string') return id; // already a RecordId object
  const bare = id.replace(/^predictions:/, '').replace(/^memos:/, '');
  const recId = new RecordId('memos', bare);
  const [rows] = await db
    .query(surql`SELECT id FROM memos WHERE kind = 'prediction' AND id = ${recId} LIMIT 1`)
    .collect();
  return rows?.[0]?.id ?? null;
}
