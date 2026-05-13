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

const VALID_PROFILE_RX = /^[a-z0-9-]+$/;
const VALID_SURFACE_RX = /^(events|memos|entities)$/;

// Per-db cache. The router used to be a single module-level snapshot, which
// silently mismapped writes when multiple isolated db handles were live —
// tests with `mem://` per case, and any future per-tenant split. Keying by
// the db handle in a WeakMap drops the entry automatically when the handle
// is garbage collected.
//
// `invalidateProfileCache()` with no args (called after `robin embeddings
// activate`) bumps a generation counter; each cache entry remembers the
// generation it was minted at, and entries from older generations are
// treated as stale on the next read.
const dbCache = new WeakMap();
let cacheGeneration = 0;
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
async function resolveProfiles(db, { force = false } = {}) {
  const now = Date.now();
  const entry = dbCache.get(db);
  if (
    !force &&
    entry &&
    entry.generation === cacheGeneration &&
    now - entry.loadedAt < CACHE_TTL_MS
  ) {
    return entry.value;
  }
  const [rows] = await db.query('SELECT VALUE value FROM runtime:embedder').collect();
  const value = rows?.[0];
  if (!value?.active_profile) {
    throw new Error(
      'runtime:embedder.value.active_profile is not set; run `robin install` or `robin embeddings activate`',
    );
  }
  const next = {
    active: value.active_profile,
    read: value.read_profile ?? value.active_profile,
  };
  dbCache.set(db, { value: next, loadedAt: now, generation: cacheGeneration });
  return next;
}

/**
 * Force the next `resolveProfiles` call to round-trip. With no args, this
 * applies globally — every cached db entry is treated as stale on its next
 * read. Pass a specific `db` to drop just that handle's entry immediately.
 */
export function invalidateProfileCache(db) {
  if (db === undefined) {
    cacheGeneration += 1;
    return;
  }
  dbCache.delete(db);
}

/** Convenience: just the write/active profile. */
export async function activeProfile(db) {
  return (await resolveProfiles(db)).active;
}

/** Convenience: just the read profile (may differ during dual-read). */
export async function readProfile(db) {
  return (await resolveProfiles(db)).read;
}
