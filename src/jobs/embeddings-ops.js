// embeddings-ops.js — daemon-side handlers for `robin embeddings` mutate ops.
// Spec §6 (embedder swap protocol).
//
// `prepare`/`activate`/`drop`/`dual-read` operate synchronously on
// `runtime:embedder` + DDL. `backfill` delegates to the resumable internal job
// in `./internal/embeddings-backfill.js`.
//
// All five paths share one daemon endpoint (`/internal/embeddings/op`) so
// server.js stays compact.

import { surql } from 'surrealdb';
import { invalidateProfileCache, tableNameSafeProfile } from '../embed/profile-router.js';
import runBackfill from './internal/embeddings-backfill.js';

const VALID_PROFILE_RX = /^[a-z0-9-]+$/;

const PROFILE_DIMENSIONS = {
  'mxbai-1024': 1024,
  'qwen3-4096': 4096,
  'gemini-3072': 3072,
};

const PROFILE_LOADERS = {
  'mxbai-1024': async () => (await import('../embed/in-process.js')).createInProcessEmbedder(),
  'qwen3-4096': async () => (await import('../embed/ollama.js')).createOllamaEmbedder(),
  'gemini-3072': async () => (await import('../embed/gemini.js')).createGeminiEmbedder(),
};

const SURFACES = ['events', 'memos', 'entities'];

function validateProfile(profile) {
  if (!profile) return { ok: false, reason: 'missing_profile' };
  if (!VALID_PROFILE_RX.test(profile)) return { ok: false, reason: 'invalid_profile_name' };
  return { ok: true };
}

function profileDim(profile) {
  const dim = PROFILE_DIMENSIONS[profile];
  if (!dim) {
    throw new Error(
      `unknown profile dimension for ${profile}; register it in PROFILE_DIMENSIONS first`,
    );
  }
  return dim;
}

function tableNames(profile) {
  const safe = tableNameSafeProfile(profile);
  return SURFACES.map((s) => `embeddings_${safe}_${s}`);
}

async function readEmbedderState(db) {
  const [rows] = await db.query('SELECT VALUE value FROM runtime:embedder').collect();
  return rows?.[0] ?? null;
}

async function tablesExist(db, names) {
  const [info] = await db.query('INFO FOR DB').collect();
  const all = info?.tables ?? {};
  return names.map((n) => ({ name: n, exists: Object.hasOwn(all, n) }));
}

// ----------------------------------------------------------------------------
// prepare — DDL three HNSW tables + register in available_profiles.
// Refuses if any of the three already exist.
// ----------------------------------------------------------------------------

export async function prepareProfile(db, { profile }) {
  const v = validateProfile(profile);
  if (!v.ok) return v;
  const names = tableNames(profile);
  const existing = (await tablesExist(db, names)).filter((t) => t.exists);
  if (existing.length) {
    return { ok: false, reason: `tables already exist: ${existing.map((t) => t.name).join(', ')}` };
  }

  const dim = profileDim(profile);
  const ddl = [];
  for (let i = 0; i < SURFACES.length; i++) {
    const surface = SURFACES[i];
    const name = names[i];
    ddl.push(
      `DEFINE TABLE ${name} SCHEMAFULL TYPE NORMAL;`,
      `DEFINE FIELD record ON ${name} TYPE record<${surface}>;`,
      `DEFINE FIELD vector ON ${name} TYPE array<float> ASSERT array::len($value) = ${dim};`,
      `DEFINE FIELD ts ON ${name} TYPE datetime DEFAULT time::now();`,
      `DEFINE INDEX ${name}_record ON ${name} FIELDS record UNIQUE;`,
      `DEFINE INDEX ${name}_vec ON ${name} FIELDS vector HNSW DIMENSION ${dim} DIST COSINE TYPE F32 EFC 200 M 16;`,
    );
  }
  const tx = `BEGIN TRANSACTION;\n${ddl.join('\n')}\nCOMMIT TRANSACTION;`;
  await db.query(tx).collect();

  const state = (await readEmbedderState(db)) ?? {};
  const available = new Set(state.available_profiles ?? []);
  available.add(profile);
  const merged = {
    ...state,
    available_profiles: [...available],
  };
  await db
    .query(surql`UPSERT type::record('runtime', 'embedder') MERGE { value: ${merged} }`)
    .collect();
  invalidateProfileCache();
  return { ok: true, tables: names };
}

// ----------------------------------------------------------------------------
// activate — atomic flip. Refuses if any of the three tables is missing.
// Sets read_profile = active_profile by default (the converged steady state).
// ----------------------------------------------------------------------------

export async function activateProfile(db, { profile }) {
  const v = validateProfile(profile);
  if (!v.ok) return v;
  const names = tableNames(profile);
  const missing = (await tablesExist(db, names)).filter((t) => !t.exists);
  if (missing.length) {
    return { ok: false, reason: `tables missing: ${missing.map((t) => t.name).join(', ')}` };
  }

  const state = (await readEmbedderState(db)) ?? {};
  const prev = state.active_profile ?? null;
  const history = Array.isArray(state.history) ? [...state.history] : [];
  const nowIso = new Date().toISOString();
  if (prev && prev !== profile) {
    const last = history.length ? history[history.length - 1] : null;
    if (last && last.profile === prev && !last.deactivated_at) {
      last.deactivated_at = nowIso;
    }
  }
  history.push({ profile, activated_at: nowIso });

  const available = new Set(state.available_profiles ?? []);
  available.add(profile);

  const merged = {
    ...state,
    active_profile: profile,
    read_profile: profile,
    available_profiles: [...available],
    history,
  };
  await db
    .query(surql`UPSERT type::record('runtime', 'embedder') MERGE { value: ${merged} }`)
    .collect();
  invalidateProfileCache();
  return { ok: true, active_profile: profile, previous: prev };
}

// ----------------------------------------------------------------------------
// dual-read — set read_profile divergent from (on) or converged with (off) the
// active profile.
// ----------------------------------------------------------------------------

export async function setDualRead(db, { state, profile }) {
  const current = (await readEmbedderState(db)) ?? {};
  if (!current.active_profile) {
    return { ok: false, reason: 'no_active_profile' };
  }
  let nextRead;
  if (state === 'off') {
    nextRead = current.active_profile;
  } else if (state === 'on') {
    let target = profile;
    if (!target) {
      const others = (current.available_profiles ?? []).filter((p) => p !== current.active_profile);
      if (others.length !== 1) {
        return {
          ok: false,
          reason: 'specify_profile_when_multiple_available',
        };
      }
      target = others[0];
    }
    const v = validateProfile(target);
    if (!v.ok) return v;
    if (!(current.available_profiles ?? []).includes(target)) {
      return { ok: false, reason: `profile not in available_profiles: ${target}` };
    }
    nextRead = target;
  } else {
    return { ok: false, reason: 'invalid_state' };
  }
  const merged = { ...current, read_profile: nextRead };
  await db
    .query(surql`UPSERT type::record('runtime', 'embedder') MERGE { value: ${merged} }`)
    .collect();
  invalidateProfileCache();
  return {
    ok: true,
    read_profile: nextRead,
    active_profile: current.active_profile,
  };
}

// ----------------------------------------------------------------------------
// drop — DROP the three tables for a profile. Refuses if profile is active or
// if any table has rows. (Use with --force after a manual purge if you really
// want it gone.)
// ----------------------------------------------------------------------------

export async function dropProfile(db, { profile }) {
  const v = validateProfile(profile);
  if (!v.ok) return v;
  const state = (await readEmbedderState(db)) ?? {};
  if (state.active_profile === profile) {
    return { ok: false, reason: 'cannot drop active profile' };
  }
  if (state.read_profile === profile && state.read_profile !== state.active_profile) {
    return { ok: false, reason: 'cannot drop profile while it is the read_profile' };
  }
  const names = tableNames(profile);
  const tables = await tablesExist(db, names);
  for (const t of tables) {
    if (!t.exists) continue;
    const [counts] = await db.query(`SELECT count() AS n FROM ${t.name} GROUP ALL`).collect();
    const n = counts?.[0]?.n ?? 0;
    if (n > 0) {
      return { ok: false, reason: `${t.name} has ${n} rows; refusing to drop` };
    }
  }
  const ddl = names.map((n) => `REMOVE TABLE IF EXISTS ${n};`).join('\n');
  await db.query(ddl).collect();

  const available = (state.available_profiles ?? []).filter((p) => p !== profile);
  const merged = { ...state, available_profiles: available };
  await db
    .query(surql`UPSERT type::record('runtime', 'embedder') MERGE { value: ${merged} }`)
    .collect();
  invalidateProfileCache();
  return { ok: true, tables: names };
}

// ----------------------------------------------------------------------------
// backfill — delegates to the resumable internal job. Long-running but
// idempotent; safe to interrupt and rerun.
// ----------------------------------------------------------------------------

export async function startBackfill(db, { profile }) {
  const v = validateProfile(profile);
  if (!v.ok) return v;
  const state = (await readEmbedderState(db)) ?? {};
  if (!(state.available_profiles ?? []).includes(profile)) {
    return {
      ok: false,
      reason: `profile not prepared: run \`robin embeddings prepare ${profile}\` first`,
    };
  }
  const names = tableNames(profile);
  const missing = (await tablesExist(db, names)).filter((t) => !t.exists);
  if (missing.length) {
    return { ok: false, reason: `tables missing: ${missing.map((t) => t.name).join(', ')}` };
  }

  const summary = await runBackfill({ db, profile });
  return { ok: true, summary };
}

// ----------------------------------------------------------------------------
// Single dispatcher used by the daemon HTTP endpoint.
// ----------------------------------------------------------------------------

export async function dispatch(db, body) {
  const op = body?.op;
  switch (op) {
    case 'prepare':
      return prepareProfile(db, body);
    case 'activate':
      return activateProfile(db, body);
    case 'dual-read':
      return setDualRead(db, body);
    case 'drop':
      return dropProfile(db, body);
    case 'backfill':
      return startBackfill(db, body);
    default:
      return { ok: false, reason: `unknown_op: ${op}` };
  }
}

// Re-exports for tests that want to override how an embedder is constructed
// inside the backfill job. Kept here so the test surface is concentrated.
export { PROFILE_DIMENSIONS, PROFILE_LOADERS, profileDim };
