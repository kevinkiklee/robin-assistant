// profile-router.js — resolves which embedding table to read/write at runtime.
//
// Spec §5.1, §6. Embeddings are stored in per-surface, per-profile tables:
//   embeddings_<profile>_<surface>
// Profile names containing dashes (e.g. 'gemini-3072') are normalized to
// underscores for the table name (SurrealDB table identifiers prefer
// underscores).
//
// `active_profile` (writes + reads) and `read_profile` (reads only, used
// during a dual-read verification window) live in `runtime:embedder`.

import { surql } from 'surrealdb';

const VALID_PROFILE_RX = /^[a-z0-9-]+$/;
const VALID_SURFACE_RX = /^(events|memos|entities)$/;

let cache = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5_000;

/**
 * Normalize a profile name for use in SurrealDB table identifiers.
 * `gemini-3072` → `gemini_3072`.
 */
export function tableNameSafeProfile(profile) {
  if (!VALID_PROFILE_RX.test(profile)) {
    throw new Error(`invalid profile name: ${profile}`);
  }
  return profile.replace(/-/g, '_');
}

/**
 * Compose an embedding table name for a (profile, surface) pair.
 * Surface ∈ {events, memos, entities}.
 */
export function embeddingTable(profile, surface) {
  if (!VALID_PROFILE_RX.test(profile)) {
    throw new Error(`invalid profile name: ${profile}`);
  }
  if (!VALID_SURFACE_RX.test(surface)) {
    throw new Error(`invalid surface: ${surface} (expected events|memos|entities)`);
  }
  return `embeddings_${tableNameSafeProfile(profile)}_${surface}`;
}

/**
 * Resolve the active embedder profile from runtime:embedder.
 * Cached for CACHE_TTL_MS to avoid repeated round-trips on hot paths.
 *
 * Returns `{ active, read }` — both are profile name strings.
 */
export async function resolveProfiles(db, { force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cacheLoadedAt < CACHE_TTL_MS) return cache;
  const [rows] = await db.query('SELECT VALUE value FROM runtime:embedder').collect();
  const value = rows?.[0];
  if (!value?.active_profile) {
    throw new Error(
      'runtime:embedder.value.active_profile is not set; run `robin install` or `robin embeddings activate`',
    );
  }
  cache = {
    active: value.active_profile,
    read: value.read_profile ?? value.active_profile,
  };
  cacheLoadedAt = now;
  return cache;
}

/** Force the next `resolveProfiles` call to round-trip. */
export function invalidateProfileCache() {
  cache = null;
  cacheLoadedAt = 0;
}

/** Convenience: just the write/active profile. */
export async function activeProfile(db) {
  return (await resolveProfiles(db)).active;
}

/** Convenience: just the read profile (may differ during dual-read). */
export async function readProfile(db) {
  return (await resolveProfiles(db)).read;
}
