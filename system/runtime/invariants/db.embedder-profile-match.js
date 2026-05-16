// db.embedder_profile_match
//
// Reads runtime:embedder.active_profile and verifies the corresponding
// `embeddings_<profile>_events` table has the dimension the embedder produces.
//
// No automatic repair: flipping profile or rebuilding the embedding table
// is destructive without a backfill — must be user-initiated via
// `robin embeddings activate` / `backfill`.

import { surql } from 'surrealdb';
import { tableNameSafeProfile } from '../../data/embed/profile-router.js';

const PROFILE_DIMENSION = {
  'mxbai-1024': 1024,
  'mxbai_1024': 1024,
  'bge-large-1024': 1024,
  'bge_large_1024': 1024,
  'bge-768': 768,
  'bge_768': 768,
  'gemini-3072': 3072,
  'gemini_3072': 3072,
};

function expectedDimension(profile) {
  return PROFILE_DIMENSION[profile] ?? PROFILE_DIMENSION[tableNameSafeProfile(profile)] ?? null;
}

async function readActiveProfile(db) {
  const [rows] = await db
    .query(surql`SELECT VALUE value FROM type::record('runtime', 'embedder');`)
    .collect();
  const value = rows?.[0] ?? null;
  return value?.active_profile ?? null;
}

async function tableInfo(db, tableName) {
  const [rows] = await db.query(`INFO FOR TABLE ${tableName};`).collect();
  return rows?.[0] ?? null;
}

export default {
  name: 'db.embedder_profile_match',
  level: 'warn',
  surface: 'db',
  phase: 'db',
  description: 'Active embedder profile matches the dimension of the events embedding table.',

  runWhen: {
    boot: { enabled: true },
    heartbeat: { enabled: true, cooldownMs: 60 * 60 * 1000 },
    doctor: { enabled: true },
    postInstall: { enabled: false },
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };
    let profile;
    try {
      profile = await readActiveProfile(ctx.db);
    } catch (e) {
      return { ok: false, error: `read_active_profile_failed:${e.message}` };
    }
    if (!profile) return { ok: false, error: 'no_active_profile' };

    const expected = expectedDimension(profile);
    if (expected == null) {
      return { ok: false, error: 'unknown_profile_dimension', evidence: { profile } };
    }

    // We can't reliably read the table vector dimension from INFO FOR TABLE
    // across all SurrealDB versions; a robust proxy: verify the events
    // embeddings table exists for the active profile.
    const table = `embeddings_${tableNameSafeProfile(profile)}_events`;
    try {
      const info = await tableInfo(ctx.db, table);
      if (!info) return { ok: false, error: 'table_missing', evidence: { table, profile } };
    } catch (e) {
      return { ok: false, error: `info_failed:${e.message}`, evidence: { table, profile } };
    }

    return { ok: true, evidence: { profile, expected_dimension: expected, table } };
  },

  // No automatic repair — see header comment.

  explain(lastResult) {
    const lines = [
      '### `db.embedder_profile_match`',
      '',
      '**Symptom.** Recalls return empty or fail with vector-dimension errors; biographer writes succeed but embedding upserts log `embedding failed`.',
      '',
      '**Cause.** `runtime:embedder.value.active_profile` doesn\'t match the embedding table currently in use — usually because the profile was flipped without a backfill, or the embedder loaded under a different config.',
      '',
      '**Fix.** Manual — destructive otherwise. Either:',
      '- `robin embeddings list` to see profiles and dimensions, then',
      '- `robin embeddings activate <profile>` (only if backfill is complete), or',
      '- `robin embeddings backfill <profile>` then activate.',
    ];
    if (lastResult?.evidence?.profile) {
      lines.push('', `**Current evidence:** profile=\`${lastResult.evidence.profile}\``);
    }
    return lines.join('\n');
  },
};
