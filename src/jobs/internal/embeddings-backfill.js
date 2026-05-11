// embeddings-backfill.js — resumable batch embedder for a target profile.
// Spec §6.1.
//
// Walks each surface (events, memos, entities) in 200-row chunks ordered by
// id ASC; embeds the surface's seed text; UPSERTs into
// `embeddings_<profile>_<surface>` with deterministic ID
// `embeddings_<profile>_<surface>:[<record_id>]`. Cursor lives in
// `runtime:embedder_backfill.value.cursors.<surface>.last_processed_id` and is
// saved after each chunk. On full drain the cursor row is DELETEd.
//
// Idempotent: re-running re-embeds nothing already covered (UPSERT-by-record
// + cursor-resume). Safe to interrupt; safe to re-run.
//
// Default invocation reads target profile from `runtime:embedder_backfill.value.profile`,
// falling back to the active profile if no cursor row exists. The
// `embeddings-ops.js` dispatcher passes `profile` directly.

import { BoundQuery, surql } from 'surrealdb';
import { createEmbedder } from '../../embed/factory.js';
import { embeddingTable, tableNameSafeProfile } from '../../embed/profile-router.js';

const CHUNK = 200;
const SURFACES = ['events', 'memos', 'entities'];

// What text feeds each surface's embedding. Keep aligned with `store.js`.
const SURFACE_SPECS = {
  events: {
    select: 'SELECT id, content FROM events WHERE id > $cursor ORDER BY id LIMIT $limit',
    selectFirst: 'SELECT id, content FROM events ORDER BY id LIMIT $limit',
    seed: (r) => r.content,
  },
  memos: {
    select: 'SELECT id, content FROM memos WHERE id > $cursor ORDER BY id LIMIT $limit',
    selectFirst: 'SELECT id, content FROM memos ORDER BY id LIMIT $limit',
    seed: (r) => r.content,
  },
  entities: {
    select: 'SELECT id, name, meta FROM entities WHERE id > $cursor ORDER BY id LIMIT $limit',
    selectFirst: 'SELECT id, name, meta FROM entities ORDER BY id LIMIT $limit',
    seed: (r) => {
      const aliases = Array.isArray(r.meta?.aliases) ? r.meta.aliases : [];
      return [r.name, ...aliases].filter(Boolean).join(', ');
    },
  },
};

async function readState(db) {
  const [rows] = await db.query('SELECT VALUE value FROM runtime:embedder_backfill').collect();
  return rows?.[0] ?? null;
}

async function writeState(db, value) {
  await db
    .query(surql`UPSERT type::record('runtime', 'embedder_backfill') MERGE { value: ${value} }`)
    .collect();
}

async function clearState(db) {
  await db.query('DELETE runtime:embedder_backfill').collect();
}

function emptyCursors() {
  const c = {};
  for (const s of SURFACES) c[s] = { last_processed_id: null, count: 0 };
  return c;
}

async function loadEmbedderFor(profile, override) {
  if (typeof override === 'function') return override(profile);
  // The default factory reads `runtime:config.embedder_profile`. For a
  // backfill targeting a *non-active* profile we go around it via the static
  // loader map keyed by profile name.
  const LOADERS = {
    'mxbai-1024': async () => (await import('../../embed/in-process.js')).createInProcessEmbedder(),
    'qwen3-4096': async () => (await import('../../embed/ollama.js')).createOllamaEmbedder(),
    'gemini-3072': async () => (await import('../../embed/gemini.js')).createGeminiEmbedder(),
  };
  const loader = LOADERS[profile];
  if (loader) return loader();
  // Unknown profile: fall back to the configured factory (lets tests register
  // custom profiles via the factory).
  return createEmbedder();
}

async function backfillSurface(db, embedder, profile, surface, state) {
  const spec = SURFACE_SPECS[surface];
  if (!spec) throw new Error(`unknown surface: ${surface}`);
  const table = embeddingTable(profile, surface);
  let cursor = state.cursors[surface]?.last_processed_id ?? null;
  let count = state.cursors[surface]?.count ?? 0;

  while (true) {
    const q = cursor
      ? new BoundQuery(spec.select, { cursor, limit: CHUNK })
      : new BoundQuery(spec.selectFirst, { limit: CHUNK });
    const [rows] = await db.query(q).collect();
    if (!rows || rows.length === 0) break;

    const usable = rows.filter((r) => {
      const t = spec.seed(r);
      return typeof t === 'string' && t.length > 0;
    });

    if (usable.length > 0) {
      const seeds = usable.map((r) => spec.seed(r));
      const vectors = await embedder.embedBatch(seeds);
      for (let i = 0; i < usable.length; i++) {
        const vec = Array.from(vectors[i]);
        await db
          .query(
            new BoundQuery(
              'UPSERT type::record($tb, [$rec]) SET record = $rec, vector = $vec, ts = time::now()',
              { tb: table, rec: usable[i].id, vec },
            ),
          )
          .collect();
      }
      count += usable.length;
    }

    cursor = rows[rows.length - 1].id;
    state.cursors[surface] = { last_processed_id: cursor, count };
    await writeState(db, state);

    if (rows.length < CHUNK) break;
  }

  state.cursors[surface] = { last_processed_id: cursor, count, drained: true };
  await writeState(db, state);
  return count;
}

/**
 * Run the backfill end-to-end for a profile. Resumes from any in-flight cursor
 * row. Returns a summary string.
 *
 * @param {object} args
 * @param {object} args.db                     SurrealDB handle
 * @param {string} [args.profile]              Target profile (defaults to row's
 *                                              profile, or active profile)
 * @param {(p: string) => Promise<object>} [args.createEmbedderFor] Test seam.
 */
export default async function embeddingsBackfill({ db, profile, createEmbedderFor } = {}) {
  let state = await readState(db);
  if (!state?.profile) {
    // Default: bootstrap state. If no profile was passed, fall back to the
    // active profile (the rare scheduled-resume case).
    let target = profile;
    if (!target) {
      const [rows] = await db.query('SELECT VALUE value FROM runtime:embedder').collect();
      target = rows?.[0]?.active_profile;
    }
    if (!target) throw new Error('embeddings-backfill: no target profile');
    state = {
      profile: target,
      started_at: new Date().toISOString(),
      cursors: emptyCursors(),
      errors: [],
    };
    await writeState(db, state);
  } else if (profile && state.profile !== profile) {
    throw new Error(
      `embeddings-backfill in-flight for ${state.profile}; cannot start ${profile} until it finishes`,
    );
  }

  // Validate table name (also catches malformed profile names).
  tableNameSafeProfile(state.profile);

  const embedder = await loadEmbedderFor(state.profile, createEmbedderFor);
  if (typeof embedder.healthCheck === 'function') {
    await embedder.healthCheck();
  }

  const totals = {};
  try {
    for (const surface of SURFACES) {
      if (state.cursors[surface]?.drained) {
        totals[surface] = state.cursors[surface].count ?? 0;
        continue;
      }
      totals[surface] = await backfillSurface(db, embedder, state.profile, surface, state);
    }
  } finally {
    if (typeof embedder.unload === 'function') {
      try {
        await embedder.unload();
      } catch {
        /* ignore */
      }
    }
  }

  // All three drained: clear the cursor row.
  await clearState(db);

  return `profile=${state.profile} events=${totals.events} memos=${totals.memos} entities=${totals.entities}`;
}
