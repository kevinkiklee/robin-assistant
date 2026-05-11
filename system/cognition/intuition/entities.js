// entities.js — query-side entity match + boost computation (A2).
//
// Three pure helpers + one cached catalog read + one batched edge lookup.

import { BoundQuery, surql } from 'surrealdb';
import { recordStringId } from '../memory/edge-registry.js';

const TOKEN_RE = /[a-z0-9][a-z0-9_-]+/gi;

/**
 * Lowercase the input, extract alphanumeric tokens, drop tokens shorter than
 * 3 chars. Returns a Set of token strings.
 */
export function tokensOf(s) {
  const out = new Set();
  if (typeof s !== 'string') return out;
  const matches = s.toLowerCase().match(TOKEN_RE) ?? [];
  for (const m of matches) {
    if (m.length >= 3) out.add(m);
  }
  return out;
}

/**
 * @param {Array<{ id: any, name: string, type?: string }>} catalog
 * @param {Set<string>} queryTokens
 * @returns {Array<{ id: any, name: string, type?: string }>}
 */
export function matchCatalogEntities(catalog, queryTokens) {
  const matched = [];
  for (const ent of catalog) {
    const nameTokens = tokensOf(ent.name);
    if (nameTokens.size === 0) continue;
    let hit = false;
    for (const t of nameTokens) {
      if (queryTokens.has(t)) {
        hit = true;
        break;
      }
    }
    if (hit) matched.push({ id: ent.id, name: ent.name, type: ent.type });
  }
  return matched;
}

/**
 * Compute the entity-boost multiplier for one memo given its `about` entity
 * id-set and the set of catalog-matched query entity ids.
 *
 * @param {Set<string>|Iterable<string>} aboutIds  Entities the memo is about.
 * @param {Set<string>} matchedEntityIds           Catalog entities matched by the query.
 * @param {{ entity_boost_per_overlap?: number, entity_boost_max?: number }} cfg
 */
export function entityBoostFromAboutIds(aboutIds, matchedEntityIds, cfg = {}) {
  if (!matchedEntityIds || matchedEntityIds.size === 0) return { boost: 1.0, count: 0 };
  let overlap = 0;
  for (const eid of aboutIds) {
    if (matchedEntityIds.has(eid)) overlap++;
  }
  if (overlap === 0) return { boost: 1.0, count: 0 };
  const perOverlap = cfg.entity_boost_per_overlap ?? 0.1;
  const max = cfg.entity_boost_max ?? 1.25;
  const boost = Math.min(max, 1.0 + perOverlap * overlap);
  return { boost, count: overlap };
}

/**
 * Harvest entities mentioned in the last N biographed events of the
 * given session. Covers entities that exist in the in-flight thread but
 * haven't yet propagated into the top-N catalog (catalog is ordered by
 * `created_at DESC` and capped, so very recent entities can fall off
 * the cap until the next biographer run). See spec §3.1 candidate (2).
 *
 * @param {import('surrealdb').Surreal} db
 * @param {string|null} sessionId
 * @param {{ priorTailLimit?: number }} [opts]
 * @returns {Promise<Array<{ id: any, name?: string, type?: string }>>}
 */
export async function matchPriorTailEntities(db, sessionId, opts = {}) {
  const limit = opts.priorTailLimit ?? 3;
  if (!sessionId) return [];
  try {
    // SurrealDB v3 requires the ORDER BY column to be in the SELECT
    // projection, so we run the inner query first (id + ts), then feed the
    // resulting ids into the edges query. Two round-trips, but small N.
    const [evtRows] = await db
      .query(
        new BoundQuery(
          `SELECT id, ts FROM events
           WHERE meta.session_id = $sid AND biographed_at IS NOT NONE
           ORDER BY ts DESC LIMIT $n`,
          { sid: sessionId, n: limit },
        ),
      )
      .collect();
    const eventIds = (evtRows ?? []).map((r) => r.id).filter(Boolean);
    if (eventIds.length === 0) return [];
    const [rows] = await db
      .query(
        new BoundQuery(
          `SELECT out AS entity FROM edges WHERE kind = 'mentions' AND in IN $ids`,
          { ids: eventIds },
        ),
      )
      .collect();
    const out = [];
    const seen = new Set();
    for (const r of rows ?? []) {
      const id = r.entity;
      const key = recordStringId(id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ id });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * One batched `SELECT in, out FROM edges WHERE kind='about' AND in IN $ids`.
 * Returns `Map<memoIdString, Set<entityIdString>>`.
 */
export async function aboutEntitiesForMemos(db, memoIds) {
  const out = new Map();
  if (!memoIds || memoIds.length === 0) return out;
  const [rows] = await db
    .query(
      new BoundQuery(
        `SELECT in AS memo, out AS entity FROM edges WHERE kind = 'about' AND in IN $ids`,
        { ids: memoIds },
      ),
    )
    .collect();
  for (const r of rows ?? []) {
    const k = recordStringId(r.memo);
    if (!k) continue;
    if (!out.has(k)) out.set(k, new Set());
    out.get(k).add(recordStringId(r.entity));
  }
  return out;
}

// Catalog cache: 60s TTL keyed by profile (so a profile flip invalidates
// stale entries). Reads top-N entities by created_at — same pattern as
// biographer/pipeline.js:32 but with a larger cap (default 500).
let _catalogCache = null;
let _catalogCachedAt = 0;
let _catalogCachedProfile = null;

export async function readEntityCatalog(db, cfg = {}) {
  const ttlMs = (cfg.entity_catalog_ttl_seconds ?? 60) * 1000;
  const size = cfg.entity_catalog_size ?? 500;
  let profile = null;
  try {
    const [rows] = await db
      .query(surql`SELECT VALUE value.active_profile FROM runtime:embedder`)
      .collect();
    profile = rows?.[0] ?? null;
  } catch {
    profile = null;
  }
  if (
    _catalogCache &&
    Date.now() - _catalogCachedAt < ttlMs &&
    _catalogCachedProfile === profile
  ) {
    return _catalogCache;
  }
  try {
    const [rows] = await db
      .query(
        new BoundQuery(
          `SELECT id, name, type FROM entities ORDER BY created_at DESC LIMIT $n`,
          { n: size },
        ),
      )
      .collect();
    _catalogCache = rows ?? [];
  } catch {
    _catalogCache = [];
  }
  _catalogCachedAt = Date.now();
  _catalogCachedProfile = profile;
  return _catalogCache;
}

export function __resetEntityCatalogCacheForTests() {
  _catalogCache = null;
  _catalogCachedAt = 0;
  _catalogCachedProfile = null;
}
