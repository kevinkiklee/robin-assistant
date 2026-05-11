import { surql } from 'surrealdb';
import { close, connect } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { readConfig, writeConfig } from '../../runtime/config.js';
import { ensureHome, paths } from '../../runtime/data-store.js';

const VALID_PROFILES = new Set(['mxbai-1024', 'qwen3-4096', 'gemini-3072']);
const USAGE = 'usage: robin embedder switch <mxbai-1024|qwen3-4096|gemini-3072>';
const BATCH = 100;

// Static loader map: avoid going through createEmbedder() (which reads config)
// while we're mid-switch. Each loader returns a ready-to-use Embedder.
const PROFILE_LOADERS = {
  'mxbai-1024': async () => (await import('../../embed/in-process.js')).createInProcessEmbedder(),
  'qwen3-4096': async () => (await import('../../embed/ollama.js')).createOllamaEmbedder(),
  'gemini-3072': async () => (await import('../../embed/gemini.js')).createGeminiEmbedder(),
};

// What text feeds each table's embedding. Keep in sync with:
//   - events: src/capture/record-event.js (uses `content`)
//   - knowledge: src/memory/knowledge.js (uses `content`)
//   - entities: src/capture/biographer.js (uses `${type}: ${name}`)
function entitySeedText(row) {
  return `${row.type}: ${row.name}`;
}

const TABLE_SPECS = {
  events: {
    fields: 'id, content',
    seedFrom: (r) => r.content,
    skipNullContent: true,
  },
  knowledge: {
    fields: 'id, content',
    seedFrom: (r) => r.content,
    skipNullContent: true,
  },
  entities: {
    fields: 'id, name, type',
    seedFrom: entitySeedText,
    skipNullContent: false,
  },
};

async function setSwitchProgress(db, table, lastId) {
  await db
    .query(
      surql`UPSERT type::record('runtime', 'embedder') MERGE {
        value: { switch_progress: { table: ${table}, last_id: ${lastId} } }
      }`,
    )
    .collect();
}

async function clearSwitchProgress(db) {
  // MERGE with null clears the field on next write; use UPDATE to remove cleanly.
  await db
    .query(surql`UPDATE type::record('runtime', 'embedder') SET value.switch_progress = NONE`)
    .collect();
}

async function readSwitchProgress(db) {
  const [rows] = await db.query(surql`SELECT * FROM type::record('runtime', 'embedder')`).collect();
  return rows?.[0]?.value?.switch_progress ?? null;
}

async function reembedTable(db, table, embedder, log) {
  const spec = TABLE_SPECS[table];
  if (!spec) throw new Error(`unknown table: ${table}`);

  // Determine starting cursor from any in-flight switch_progress row.
  const progress = await readSwitchProgress(db);
  let cursor = null;
  if (progress && progress.table === table && progress.last_id) {
    cursor = progress.last_id;
  }
  let total = 0;

  while (true) {
    // Build cursor-paginated SELECT. Table name is from a static whitelist; safe
    // to inline. id > $cursor uses surql binding so SurrealDB handles record id
    // comparison correctly.
    const rows = cursor
      ? (
          await db
            .query(
              `SELECT ${spec.fields} FROM ${table} WHERE id > $cursor ORDER BY id LIMIT ${BATCH}`,
              { cursor },
            )
            .collect()
        )[0]
      : (
          await db.query(`SELECT ${spec.fields} FROM ${table} ORDER BY id LIMIT ${BATCH}`).collect()
        )[0];

    if (!rows || rows.length === 0) break;

    // Filter rows we can actually embed.
    const usable = rows.filter((r) => {
      if (spec.skipNullContent) {
        const seed = spec.seedFrom(r);
        return typeof seed === 'string' && seed.length > 0;
      }
      return true;
    });

    if (usable.length > 0) {
      const seeds = usable.map((r) => spec.seedFrom(r));
      const vectors = await embedder.embedBatch(seeds);
      for (let i = 0; i < usable.length; i++) {
        const arr = Array.from(vectors[i]);
        await db.query(surql`UPDATE ${usable[i].id} SET embedding = ${arr}`).collect();
      }
      total += usable.length;
    }

    cursor = rows[rows.length - 1].id;
    await setSwitchProgress(db, table, cursor);
  }

  log(`  ${table}: re-embedded ${total} row${total === 1 ? '' : 's'}`);
  return total;
}

export async function embedderSwitch(argv, options = {}) {
  const target = argv[0];
  if (!target || !VALID_PROFILES.has(target)) {
    console.error(USAGE);
    process.exit(1);
    return;
  }

  await ensureHome();
  const cfg = await readConfig();
  const current = cfg?.embedder_profile;
  if (!current) {
    console.error('no embedder profile configured. Run `robin install` first before switching.');
    process.exit(1);
    return;
  }
  console.log(`current embedder profile: ${current}`);

  if (target === current) {
    console.log(`already on ${current}; nothing to do`);
    return;
  }

  // Resolve the target embedder factory. Tests inject a stub via options;
  // production loads the matching impl directly so we don't depend on
  // config.json being already updated.
  const factory = options.createEmbedderFor ?? PROFILE_LOADERS[target];
  if (!factory) {
    console.error(`no loader for profile ${target}`);
    process.exit(1);
    return;
  }

  // Validate the target embedder is reachable BEFORE we touch config or schema.
  let embedder;
  try {
    embedder = await factory(target);
    if (typeof embedder.healthCheck === 'function') {
      await embedder.healthCheck();
    }
  } catch (e) {
    console.error(`target embedder ${target} not reachable: ${e.message}`);
    process.exit(1);
    return;
  }

  console.log(`switching ${current} → ${target} (db: ${paths.data.db()})`);

  // Connect to the on-disk DB. Tests inject a pre-opened db handle to avoid
  // the cost / single-process lock of opening a real rocksdb store.
  const ownsDb = !options.db;
  const db = options.db ?? (await connect({ engine: `rocksdb://${paths.data.db()}` }));
  try {
    // Step 1: write the new profile to config.json so runMigrations picks the
    // matching 0008 file.
    await writeConfig({ ...(cfg ?? {}), embedder_profile: target });

    // Step 2: clear stale-dim vector data before redefining the schema. The
    // HNSW index can't be rebuilt at a new dimension while old vectors live
    // in the same column, so:
    //   - events.embedding is option<...>; set NONE to keep the row + content
    //     so we can re-embed below.
    //   - knowledge/entities/recall_log are derived data — regenerated by
    //     Dream + biographer + the recall feedback loop. Truncating them is
    //     the cleanest path; users get a warning.
    await db.query('UPDATE events SET embedding = NONE').collect();
    await db.query('DELETE knowledge').collect();
    await db.query('DELETE entities').collect();
    await db.query('DELETE recall_log').collect();

    // Step 3: drop the old 0008 row from _migrations so the runner re-applies
    // the (different) 0008-embedder-<target>.surql. The runner refuses on
    // checksum mismatch otherwise.
    await db.query(surql`DELETE _migrations WHERE version = 8`).collect();

    // Step 4: re-run migrations. Only 0008 is missing; runner re-applies just
    // that file and writes a fresh _migrations row at the new dimension.
    await runMigrations(db, paths.source.migrations());

    // Step 5: re-embed events (knowledge/entities/recall_log are empty —
    // they regenerate from raw events via Dream and biographer).
    const reembedded = await reembedTable(db, 'events', embedder, console.log);

    // Step 6: clear switch_progress on success.
    await clearSwitchProgress(db);

    console.log(
      `switched from ${current} to ${target}; re-embedded ${reembedded} events. knowledge/entities/recall_log were cleared and will regenerate from raw events.`,
    );
  } catch (e) {
    console.error(`switch failed mid-flight: ${e.message}`);
    console.error(
      `switch_progress preserved — re-run \`robin embedder switch ${target}\` to resume.`,
    );
    process.exit(1);
    return;
  } finally {
    if (ownsDb) await close(db);
    if (typeof embedder?.unload === 'function') {
      try {
        await embedder.unload();
      } catch {
        /* ignore */
      }
    }
  }
}
