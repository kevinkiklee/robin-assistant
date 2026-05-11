import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { embedderSwitch } from '../../src/cli/commands/embedder-switch.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

let tmpHome;
let exitCode;
let origExit;
let stdout;
let stderr;
let origLog;
let origErr;

test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;

  exitCode = 0;
  origExit = process.exit;
  process.exit = (c) => {
    exitCode = c ?? 0;
    throw new Error(`__test_exit_${exitCode}__`);
  };

  stdout = [];
  stderr = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
});

test.afterEach(() => {
  process.exit = origExit;
  console.log = origLog;
  console.error = origErr;
  rmSync(tmpHome, { recursive: true, force: true });
});

function makeEmbedderFactory(dimension, profile) {
  return async () => {
    const stub = createStubEmbedder({ dimension });
    return {
      ...stub,
      profile,
      modelId: `stub:${profile}`,
      healthCheck: async () => {},
    };
  };
}

async function withCaughtExit(fn) {
  try {
    await fn();
  } catch (e) {
    if (!String(e.message).startsWith('__test_exit_')) throw e;
  }
}

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../src/schema/migrations');

test('embedder switch rejects unknown profile with usage message', async () => {
  await withCaughtExit(() => embedderSwitch(['unknown-xxx']));
  assert.equal(exitCode, 1);
  assert.ok(
    stderr.join('\n').match(/usage|unknown profile|mxbai-1024/i),
    'expected usage/error in stderr',
  );
});

test('embedder switch is a no-op when target equals current profile', async () => {
  const { writeConfig } = await import('../../src/runtime/config.js');
  await writeConfig({ embedder_profile: 'mxbai-1024' });

  await withCaughtExit(() =>
    embedderSwitch(['mxbai-1024'], {
      createEmbedderFor: makeEmbedderFactory(1024, 'mxbai-1024'),
    }),
  );
  assert.equal(exitCode, 0);
  const out = stdout.join('\n');
  assert.match(out, /already on mxbai-1024|nothing to do/i);
});

test('embedder switch changes profile, rewrites schema, and re-embeds rows', async () => {
  const { writeConfig, readConfig } = await import('../../src/runtime/config.js');
  await writeConfig({ embedder_profile: 'mxbai-1024' });

  // Build mxbai-1024 schema on an in-memory DB and seed rows.
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, MIGRATIONS_DIR);
    const seed = createStubEmbedder({ dimension: 1024 });
    for (const text of ['alpha', 'beta', 'gamma']) {
      const vec = Array.from(await seed.embed(text));
      await db
        .query(
          surql`CREATE events CONTENT ${{
            source: 'cli',
            content: text,
            content_hash: text,
          }}`,
        )
        .collect();
    }
    for (const text of ['fact1', 'fact2']) {
      const vec = Array.from(await seed.embed(text));
      await db
        .query(
          surql`CREATE knowledge CONTENT ${{
            content: text,
            content_hash: text,
            confidence: 0.5,
            source_events: [],
            source_episodes: [],
          }}`,
        )
        .collect();
    }
    for (const name of ['EntityOne']) {
      const vec = Array.from(await seed.embed(`thing: ${name}`));
      await db
        .query(
          surql`CREATE entities CONTENT ${{
            name,
            type: 'thing',
          }}`,
        )
        .collect();
    }

    // Switch to qwen3-4096 with an injected stub factory and shared db handle.
    await withCaughtExit(() =>
      embedderSwitch(['qwen3-4096'], {
        createEmbedderFor: makeEmbedderFactory(4096, 'qwen3-4096'),
        db,
      }),
    );
    if (exitCode !== 0) {
      throw new Error(
        `expected exit 0, got ${exitCode}; stderr=${stderr.join('\n')}; stdout=${stdout.join('\n')}`,
      );
    }
    assert.equal(exitCode, 0);
    const out = stdout.join('\n');
    assert.match(out, /switched/i, 'expected success message');

    // Config changed
    const cfg = await readConfig();
    assert.equal(cfg.embedder_profile, 'qwen3-4096');

    // Schema dim now 4096.
    const newSeed = createStubEmbedder({ dimension: 4096 });
    const okVec = Array.from(await newSeed.embed('roundtrip'));
    await db
      .query(
        surql`CREATE events CONTENT ${{
          source: 'cli',
          content: 'roundtrip',
          content_hash: 'roundtrip-h',
        }}`,
      )
      .collect();
    const badVec = Array.from(await seed.embed('bad'));
    await assert.rejects(() =>
      db
        .query(
          surql`CREATE events CONTENT ${{
            source: 'cli',
            content: 'bad',
            content_hash: 'bad-h',
          }}`,
        )
        .collect(),
    );

    // Events: re-embedded at new dim (content preserved).
    const [eventRows] = await db
      .query(
        surql`SELECT id, embedding FROM events WHERE content_hash IN ['alpha', 'beta', 'gamma']`,
      )
      .collect();
    assert.equal(eventRows.length, 3, 'three seeded events still present');
    for (const r of eventRows) {
      assert.equal(r.embedding.length, 4096, `event ${r.id} re-embedded at new dim`);
    }
    // Knowledge / entities: derived data, cleared on switch (regenerate via Dream + biographer).
    const [kRows] = await db.query(surql`SELECT id FROM knowledge`).collect();
    assert.equal(kRows.length, 0, 'knowledge cleared on switch (regenerates from events)');
    const [entRows] = await db.query(surql`SELECT id FROM entities`).collect();
    assert.equal(entRows.length, 0, 'entities cleared on switch (regenerates from events)');

    // runtime:embedder reflects the new profile.
    const [rt] = await db.query(surql`SELECT * FROM type::record('runtime', 'embedder')`).collect();
    assert.equal(rt[0].value.profile, 'qwen3-4096');
    assert.equal(rt[0].value.dimension, 4096);
    // switch_progress cleared after success.
    assert.ok(
      rt[0].value.switch_progress === undefined || rt[0].value.switch_progress === null,
      'switch_progress cleared on success',
    );
  } finally {
    await close(db);
  }
});

test('embedder switch is resumable: re-runs survive a stale switch_progress row', async () => {
  const { writeConfig, readConfig } = await import('../../src/runtime/config.js');
  await writeConfig({ embedder_profile: 'mxbai-1024' });

  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, MIGRATIONS_DIR);
    const seed = createStubEmbedder({ dimension: 1024 });
    for (const text of ['e1', 'e2', 'e3', 'e4']) {
      const vec = Array.from(await seed.embed(text));
      await db
        .query(
          surql`CREATE events CONTENT ${{
            source: 'cli',
            content: text,
            content_hash: text,
          }}`,
        )
        .collect();
    }

    // First switch: should re-embed all 4 events.
    await withCaughtExit(() =>
      embedderSwitch(['qwen3-4096'], {
        createEmbedderFor: makeEmbedderFactory(4096, 'qwen3-4096'),
        db,
      }),
    );
    assert.equal(exitCode, 0);
    const cfgAfterFirst = await readConfig();
    assert.equal(cfgAfterFirst.embedder_profile, 'qwen3-4096');

    // Plant a stale switch_progress row to simulate a resume scenario.
    await db
      .query(
        surql`UPSERT type::record('runtime', 'embedder') MERGE {
          value: { switch_progress: { table: 'events', last_id: 'sentinel' } }
        }`,
      )
      .collect();

    // Reset capture state and run a no-op switch — should still exit 0.
    exitCode = 0;
    stdout.length = 0;
    stderr.length = 0;
    await withCaughtExit(() =>
      embedderSwitch(['qwen3-4096'], {
        createEmbedderFor: makeEmbedderFactory(4096, 'qwen3-4096'),
        db,
      }),
    );
    assert.equal(exitCode, 0);
    const cfgAfterNoop = await readConfig();
    assert.equal(cfgAfterNoop.embedder_profile, 'qwen3-4096');
  } finally {
    await close(db);
  }
});
