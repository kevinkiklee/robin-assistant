// state_inference.js — lens for kind='state_inference' memos.
// Cognition D1 spec §1.1, §2. Thin wrapper around store.note that bakes
// kind='state_inference', derived_by='state-inference', and meta.dimension
// (default 'current_focus') into the write path. Read APIs filter by
// meta.source and (implicitly) exclude superseded rows.

import { BoundQuery, surql } from 'surrealdb';
import * as store from './store.js';

const DEFAULT_DIMENSION = 'current_focus';
const DEFAULT_DERIVED_BY = 'state-inference';

/**
 * Write a state_inference memo.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {{embed:(t:string)=>Promise<Float32Array>}} embedder
 * @param {{
 *   source: string,                         // 'agent:claude-code' etc.
 *   content: string,                        // ≤ 240 chars; caller clamps
 *   confidence: number,                     // already clamped to [0.05, 0.95]
 *   entities?: import('surrealdb').RecordId[],  // → meta.entities + about edges
 *   arc_id?: import('surrealdb').RecordId|null,
 *   last_event_id?: import('surrealdb').RecordId|null,
 *   lineage?: import('surrealdb').RecordId[],   // up to 5 contributing event refs
 *   evidence_snippet?: string,              // ≤ 120 chars
 *   last_active_at: Date,
 *   from_signal: string[],                  // e.g. ['attention','arcs','biographer']
 *   signal_hash: string,
 *   dimension?: string,                     // defaults to 'current_focus'
 *   scope?: string,                         // 'global' (default) or 'private'
 *   tags?: string[],
 * }} input
 * @returns {Promise<{ id: import('surrealdb').RecordId, deduped: boolean }>}
 */
export async function noteStateInference(db, embedder, input) {
  if (!input?.source) throw new Error('noteStateInference: source required');
  if (!input?.content) throw new Error('noteStateInference: content required');
  if (!input?.signal_hash) throw new Error('noteStateInference: signal_hash required');
  if (!(input.last_active_at instanceof Date)) {
    throw new Error('noteStateInference: last_active_at must be a Date');
  }

  const entities = Array.isArray(input.entities) ? input.entities : [];
  const lineage = Array.isArray(input.lineage) ? input.lineage : [];

  const meta = {
    dimension: input.dimension ?? DEFAULT_DIMENSION,
    source: input.source,
    entities: entities.map((id) => String(id)),
    arc_id: input.arc_id != null ? String(input.arc_id) : null,
    last_event_id: input.last_event_id != null ? String(input.last_event_id) : null,
    evidence_snippet: input.evidence_snippet ?? null,
    last_active_at: input.last_active_at.toISOString(),
    from_signal: Array.isArray(input.from_signal) ? input.from_signal : [],
    signal_hash: input.signal_hash,
  };

  return await store.note(db, embedder, 'state_inference', {
    content: input.content,
    confidence: input.confidence,
    derived_by: DEFAULT_DERIVED_BY,
    scope: input.scope ?? 'global',
    tags: Array.isArray(input.tags) ? input.tags : [],
    subjects: entities,
    lineage,
    meta,
  });
}

/**
 * Most-recent non-superseded state_inference memo for a source. Returns null
 * when the source has no memo or all memos are superseded.
 *
 * Filter chain (mirrors the spec §1.3 step 1):
 *   - kind = 'state_inference'
 *   - meta.source = <source>
 *   - no inbound supersedes edge (`<-supersedes` count = 0)
 *   - ORDER BY derived_at DESC LIMIT 1
 */
export async function latestForSource(db, source) {
  if (!source) return null;
  const [rows] = await db
    .query(
      surql`SELECT * FROM memos
            WHERE kind = 'state_inference'
              AND meta.source = ${source}
              AND count(<-supersedes) = 0
            ORDER BY derived_at DESC
            LIMIT 1`,
    )
    .collect();
  const row = rows?.[0];
  return row ?? null;
}

/**
 * Recent state_inference memos across all sources (superseded included or
 * excluded per `includeSuperseded`). Used by `explain_state_inference` and
 * by `robin doctor --health` rollups.
 */
export async function listRecent(db, { limit = 20, source, includeSuperseded = false } = {}) {
  const clauses = [`kind = 'state_inference'`];
  const binds = { limit };
  if (source) {
    clauses.push(`meta.source = $source`);
    binds.source = source;
  }
  if (!includeSuperseded) {
    clauses.push(`count(<-supersedes) = 0`);
  }
  const sql = `SELECT * FROM memos WHERE ${clauses.join(' AND ')} ORDER BY derived_at DESC LIMIT $limit`;
  const [rows] = await db.query(new BoundQuery(sql, binds)).collect();
  return rows ?? [];
}
