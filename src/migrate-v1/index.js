import { surql } from 'surrealdb';
import { runCapturePhase } from './phases/capture.js';
import { runEdgesPhase } from './phases/edges.js';
import { runEntityPhase } from './phases/entity.js';
import { runEpisodePhase } from './phases/episode.js';
import { runLossyPhase } from './phases/lossy.js';
import { createResolver } from './resolver.js';
import { openV1 } from './v1-client.js';

const PROGRESS_ID = "type::record('runtime', 'migration_progress')";

async function readProgress(db) {
  const [rows] = await db.query(`SELECT * FROM ${PROGRESS_ID}`).collect();
  return rows[0]?.value?.v1_to_v2 ?? null;
}

async function writeProgress(db, value) {
  await db
    .query(
      surql`UPSERT type::record('runtime', 'migration_progress') SET value = ${{ v1_to_v2: value }}`,
    )
    .collect();
}

function makeProgress(initial, db) {
  const state = initial ?? {
    started_at: new Date().toISOString(),
    completed_phases: [],
    current_phase: null,
    cursor: {},
    counts: {},
  };

  const progress = {
    state,
    advance({ phase, last_v1_id, imported = 0, dup = 0, skipped = 0 }) {
      state.current_phase = phase;
      state.cursor = { ...state.cursor, [phase]: { last_v1_id } };
      state.counts[phase] = state.counts[phase] ?? { imported: 0, dup: 0, skipped: 0 };
      state.counts[phase].imported += imported;
      state.counts[phase].dup += dup;
      state.counts[phase].skipped += skipped;
      // best-effort persistence; do not block on write failures
      writeProgress(db, state).catch(() => {});
    },
    async completePhase(phase) {
      if (!state.completed_phases.includes(phase)) state.completed_phases.push(phase);
      state.current_phase = null;
      return writeProgress(db, state);
    },
    get cursor() {
      return state.cursor;
    },
  };

  return progress;
}

const ALL_PHASES = ['entity', 'episode', 'capture', 'edges', 'lossy'];

/**
 * Run a v1 → v2 migration.
 *
 * @param {object} opts
 * @param {string} opts.sourcePath      Path to v1 package root (or rocksdb data dir).
 * @param {object} [opts.v1Handle]      Pre-opened v1 handle (skips openV1 path lookup).
 *                                      Use in tests to avoid same-process rocksdb reopen.
 * @param {object} opts.v2db            Open v2 SurrealDB connection.
 * @param {object} opts.embedder        Embedder with `.dimension` and `.embed`/`.embedBatch`.
 * @param {Function} [opts.log]         Logger function (default: console.log).
 * @param {string|null} [opts.only]     Run only this phase name; skip all others.
 */
export async function runMigration({
  sourcePath,
  v1Handle = null,
  v2db,
  embedder,
  log = console.log,
  only = null,
}) {
  const v1 = v1Handle ?? (await openV1(sourcePath));
  try {
    const resolver = createResolver(v2db);
    await resolver.load();

    const initial = await readProgress(v2db);
    const progress = makeProgress(initial, v2db);

    const phases = only ? [only] : ALL_PHASES;
    const out = { phases: {} };

    for (const ph of phases) {
      if (progress.state.completed_phases.includes(ph)) {
        log(`[migrate-v1] ${ph} already complete; skipping`);
        out.phases[ph] = { imported: 0, dup: 0, alreadyDone: true };
        continue;
      }
      log(`[migrate-v1] starting phase: ${ph}`);
      const ctx = { v1, v2db, resolver, embedder, progress };
      let r;
      if (ph === 'entity') r = await runEntityPhase(ctx);
      else if (ph === 'episode') r = await runEpisodePhase(ctx);
      else if (ph === 'capture') r = await runCapturePhase(ctx);
      else if (ph === 'edges') r = await runEdgesPhase(ctx);
      else if (ph === 'lossy') r = await runLossyPhase(ctx);
      else throw new Error(`unknown phase: ${ph}`);

      out.phases[ph] = r;
      await resolver.persist();
      await progress.completePhase(ph);
      log(`[migrate-v1] phase ${ph} done: ${JSON.stringify(r)}`);
    }

    return out;
  } finally {
    // Only close if we opened v1 ourselves; caller owns externally-supplied handles.
    if (!v1Handle) await v1.close();
  }
}
