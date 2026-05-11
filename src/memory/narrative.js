// narrative.js — multi-episode arcs (memos kind='thread').
// Spec §5 / replaces threads.js.

import { BoundQuery } from 'surrealdb';
import * as store from './store.js';

/**
 * Create a new narrative arc (thread).
 */
export async function add(db, embedder, { title, summary, episode_ids = [], entity_ids = [] }) {
  const content = summary ?? title ?? '(untitled thread)';
  return store.note(db, embedder, 'thread', {
    content,
    derived_by: 'dream',
    meta: { title, summary, episode_ids, entity_ids },
  });
}

export async function list(db, { since, limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`narrative.list: limit out of range [1,1000]: ${limit}`);
  }
  const filters = ["kind = 'thread'"];
  const bindings = {};
  if (since) {
    filters.push('last_active >= $since');
    bindings.since = new Date(since);
  }
  const sql = `
    SELECT id, content, derived_at AS started_at, last_active, meta
    FROM memos
    WHERE ${filters.join(' AND ')}
    ORDER BY last_active DESC LIMIT ${limit}
  `;
  const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
  return rows.map((r) => ({
    id: r.id,
    title: r.meta?.title,
    started_at: r.started_at,
    last_active: r.last_active,
    episode_ids: r.meta?.episode_ids ?? [],
    entity_ids: r.meta?.entity_ids ?? [],
    summary: r.meta?.summary,
  }));
}

// Legacy aliases for backward compatibility during migration.
export const createThread = add;
export const listThreads = list;
