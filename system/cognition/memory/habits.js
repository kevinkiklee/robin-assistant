// habits.js — recurring observations (memos kind='habit').
// Spec §5 / replaces patterns.js. Habits dedup by meta.name; each re-observation
// increments signal_count.

import { BoundQuery } from 'surrealdb';
import * as store from './store.js';

/**
 * Create a one-off habit (rare; prefer `upsert`).
 */
export async function add(db, embedder, { name, description, lineage, strength = 1.0 }) {
  return store.note(db, embedder, 'habit', {
    content: description,
    derived_by: 'dream',
    lineage,
    meta: { name, description, strength },
  });
}

/**
 * Upsert a habit by its `meta.name`. The first call creates; subsequent calls
 * with the same name increment `signal_count` and refresh `last_active`.
 */
export async function upsert(db, embedder, { name, description, lineage, strength = 1.0 }) {
  return store.upsertMemoByName(db, embedder, 'habit', {
    name,
    content: description,
    derived_by: 'dream',
    lineage,
    meta: { name, description, strength },
  });
}

export async function list(db, { activeOnly = false, limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`habits.list: limit out of range [1,1000]: ${limit}`);
  }
  const filters = ["kind = 'habit'"];
  if (activeOnly) filters.push('meta.strength > 0');
  const sql = `
    SELECT id, content, signal_count, last_active, meta
    FROM memos
    WHERE ${filters.join(' AND ')}
    ORDER BY last_active DESC LIMIT ${limit}
  `;
  const [rows] = await db.query(new BoundQuery(sql, {})).collect();
  // Map to legacy-shaped rows so old callers don't have to change.
  return rows.map((r) => ({
    id: r.id,
    name: r.meta?.name,
    description: r.meta?.description ?? r.content,
    signal_count: r.signal_count,
    strength: r.meta?.strength ?? 1.0,
    last_signal: r.last_active,
  }));
}

// Legacy aliases for backward compatibility during migration.
export const createPattern = add;
export const upsertPatternByName = upsert;
export const listPatterns = list;
