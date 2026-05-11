// src/jobs/action-trust.js
import { surql } from 'surrealdb';

function classOf(tool, action) {
  return `${tool}:${action}`;
}

const DATETIME_FIELDS = ['last_used_at', 'last_state_change_at', 'updated_at'];

function normalizeRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of DATETIME_FIELDS) {
    const v = out[f];
    if (v != null && typeof v.toDate === 'function') {
      out[f] = v.toDate();
    }
  }
  return out;
}

export async function getActionTrust(db, cls) {
  const [rows] = await db.query(surql`SELECT * FROM action_trust WHERE class = ${cls} LIMIT 1`);
  return normalizeRow(rows?.[0] ?? null);
}

export async function listActionTrust(db) {
  const [rows] = await db.query(surql`SELECT * FROM action_trust ORDER BY class ASC`);
  return (rows ?? []).map(normalizeRow);
}

export async function checkActionTrust(db, tool, action) {
  const cls = classOf(tool, action);
  const existing = await getActionTrust(db, cls);
  if (existing) return existing;
  const row = {
    class: cls,
    state: 'ASK',
    set_by: 'default',
    success_count: 0,
    correction_count: 0,
    last_state_change_at: new Date(),
  };
  await db.query(surql`CREATE action_trust CONTENT ${row}`);
  return await getActionTrust(db, cls);
}

export async function setActionTrust(db, cls, state, set_by) {
  const parts = cls.split(':');
  const tool = parts[0];
  const action = parts.slice(1).join(':') || '_default';
  await checkActionTrust(db, tool, action);
  await db.query(
    surql`UPDATE action_trust MERGE ${{
      state,
      set_by,
      last_state_change_at: new Date(),
    }} WHERE class = ${cls}`,
  );
}

export async function recordOutcome(db, cls, outcome) {
  const row = await getActionTrust(db, cls);
  if (!row) return;
  const patch = { last_used_at: new Date() };
  if (outcome === 'success') {
    patch.success_count = (row.success_count ?? 0) + 1;
  } else if (outcome === 'correction') {
    patch.correction_count = (row.correction_count ?? 0) + 1;
    if (row.state === 'AUTO') {
      patch.state = 'ASK';
      patch.set_by = 'correction';
      patch.last_state_change_at = new Date();
    }
  }
  await db.query(surql`UPDATE action_trust MERGE ${patch} WHERE class = ${cls}`);
}

export async function demoteOnCorrection(db, cls) {
  const row = await getActionTrust(db, cls);
  if (!row) return { demoted: false };
  if (row.state !== 'AUTO') {
    await recordOutcome(db, cls, 'correction');
    return { demoted: false };
  }
  await recordOutcome(db, cls, 'correction');
  return { demoted: true, from: 'AUTO' };
}

export async function resetActionTrust(db, cls) {
  const row = await getActionTrust(db, cls);
  if (!row) return;
  await db.query(
    surql`UPDATE action_trust MERGE ${{
      state: 'ASK',
      set_by: 'default',
      last_state_change_at: new Date(),
    }} WHERE class = ${cls}`,
  );
}
