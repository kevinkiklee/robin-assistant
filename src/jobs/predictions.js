// src/jobs/predictions.js
import { surql } from 'surrealdb';

export async function recordPrediction(
  db,
  { statement, kind, confidence, expected_resolution_at },
) {
  const row = {
    statement,
    kind,
    confidence,
    expected_resolution_at: expected_resolution_at ? new Date(expected_resolution_at) : undefined,
  };
  const [rows] = await db.query(surql`CREATE predictions CONTENT ${row}`).collect();
  return { id: String(rows[0].id) };
}

export async function resolvePrediction(db, { id, correct, actual_outcome }) {
  const existing = await getPrediction(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.resolved_at) return { ok: false, reason: 'already_resolved' };
  const fields = {
    resolved_at: new Date(),
    correct: !!correct,
  };
  if (actual_outcome !== undefined && actual_outcome !== null) {
    fields.actual_outcome = actual_outcome;
  }
  await db
    .query(
      surql`UPDATE type::record('predictions', ${id.replace(/^predictions:/, '')}) MERGE ${fields}`,
    )
    .collect();
  return { ok: true };
}

export async function getPrediction(db, id) {
  const bareId = String(id).replace(/^predictions:/, '');
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('predictions', ${bareId})`)
    .collect();
  return rows?.[0] ?? null;
}

export async function listOpenPredictions(db, { kind, older_than_days } = {}) {
  let sql = 'SELECT * FROM predictions WHERE resolved_at IS NONE';
  const args = {};
  if (kind) {
    sql += ' AND kind = $kind';
    args.kind = kind;
  }
  if (older_than_days) {
    const cutoff = new Date(Date.now() - older_than_days * 86_400_000);
    sql += ' AND predicted_at < $cutoff';
    args.cutoff = cutoff;
  }
  sql += ' ORDER BY predicted_at DESC';
  const [rows] = await db.query(sql, args).collect();
  return rows ?? [];
}

export async function listAllPredictions(db, { kind, resolved } = {}) {
  let sql = 'SELECT * FROM predictions WHERE true';
  const args = {};
  if (kind) {
    sql += ' AND kind = $kind';
    args.kind = kind;
  }
  if (resolved === true) sql += ' AND resolved_at IS NOT NONE';
  if (resolved === false) sql += ' AND resolved_at IS NONE';
  sql += ' ORDER BY predicted_at DESC';
  const [rows] = await db.query(sql, args).collect();
  return rows ?? [];
}

export async function computeCalibration(db) {
  const [resolved] = await db
    .query(surql`SELECT kind, correct FROM predictions WHERE resolved_at IS NOT NONE`)
    .collect();
  const [openRows] = await db
    .query(surql`SELECT count() AS n FROM predictions WHERE resolved_at IS NONE GROUP ALL`)
    .collect();
  const by_kind = {};
  for (const r of resolved ?? []) {
    const k = r.kind;
    if (!by_kind[k]) by_kind[k] = { resolved: 0, correct: 0, accuracy: 0 };
    by_kind[k].resolved += 1;
    if (r.correct) by_kind[k].correct += 1;
  }
  for (const k of Object.keys(by_kind)) {
    by_kind[k].accuracy = by_kind[k].resolved === 0 ? 0 : by_kind[k].correct / by_kind[k].resolved;
  }
  return {
    by_kind,
    total_open: openRows?.[0]?.n ?? 0,
    total_resolved: (resolved ?? []).length,
    last_computed_at: new Date(),
  };
}

export async function setCalibration(db, calibration) {
  await db.query(surql`UPSERT profile:singleton MERGE ${{ calibration }}`).collect();
}

export async function getCalibration(db) {
  const [rows] = await db.query(surql`SELECT calibration FROM profile:singleton`).collect();
  return rows?.[0]?.calibration ?? null;
}
