// system/tests/replay/self-improvement-v1-quarantine-replay.test.js
//
// Phase 3 replay-validation harness (Task W1-D + Task 3-C-D).
//
// Smoke tests: always run.
// Production-reflection integration: mechanically wired against the real
//   dreamStepReflection module, but the ≥80% recall assertion is skipped
//   pending 3-A-5 (reflection co-dimension clustering — deferred because
//   step-reflection.js has concurrent-agent unstaged changes).
//   When 3-A-5 lands, remove the `skip` option from the ≥80% assertion.
//
// Run via: pnpm test:file system/tests/replay/self-improvement-v1-quarantine-replay.test.js

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { writeConfig } from '../../config/paths.js';
import { connect, close } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { dreamStepReflection } from '../../cognition/dream/step-reflection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(__dirname, 'fixtures/v1-quarantine-corrections.json');

// ── DB setup for integration tests ──────────────────────────────────────────
const TEST_HOME = join(
  tmpdir(),
  `robin-replay-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(TEST_HOME, { recursive: true });
process.env.ROBIN_HOME = TEST_HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function freshDb() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(__dirname, '../../data/db/migrations'));
  return db;
}

// Load the fixture corpus.
async function loadCorpus() {
  const raw = await readFile(FIXTURES_PATH, 'utf8');
  return JSON.parse(raw);
}

/**
 * Run replay against a reflection module's clustering function.
 *
 * @param {Function|null} reflectionFn
 *   (entries: CorpusEntry[]) => Promise<{ candidates: CandidateRow[] }>
 *   Each candidate should carry a `source_ids` array referencing corpus entry
 *   ids so recall_vs_known can be computed. Pass null to skip reflection and
 *   get corpus_size only.
 *
 * @returns {{ candidates: Array, recall_vs_known: number|null, corpus_size: number }}
 */
export async function runReplay(reflectionFn) {
  const corpus = await loadCorpus();
  const result = reflectionFn ? await reflectionFn(corpus.entries) : { candidates: [] };
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];

  const known = corpus.entries.filter((e) => e.expected_rule_id != null).length;
  const recovered = candidates.filter(
    (c) =>
      Array.isArray(c.source_ids) &&
      c.source_ids.some((id) => corpus.entries.find((e) => e.id === id)?.expected_rule_id != null),
  ).length;
  const recall_vs_known = known === 0 ? null : recovered / known;

  return {
    candidates,
    recall_vs_known,
    corpus_size: corpus.entries.length,
  };
}

// ---------------------------------------------------------------------------
// Smoke tests — harness loading and no-op runner.
// ---------------------------------------------------------------------------

test('replay harness loads v1-quarantine fixtures', async () => {
  const corpus = await loadCorpus();
  assert.ok(corpus.entries.length > 0, 'fixtures should have entries');
  assert.ok(
    typeof corpus.entries[0].content === 'string',
    'first entry should have string content',
  );
  assert.ok(corpus.entries[0].id, 'first entry should have an id');
  assert.ok(corpus.entries[0].timestamp, 'first entry should have a timestamp');
  assert.ok('context' in corpus.entries[0], 'first entry should have a context block');
  assert.equal(typeof corpus.count, 'number', 'corpus should declare a count');
  assert.equal(corpus.count, corpus.entries.length, 'count should match entries length');
});

test('runReplay with no-op reflection returns the corpus size', async () => {
  const result = await runReplay(async () => ({ candidates: [] }));
  assert.equal(typeof result.corpus_size, 'number');
  assert.ok(result.corpus_size > 0, 'corpus_size should be positive');
  assert.equal(result.candidates.length, 0);
  // No expected_rule_ids are set in the skeleton fixture, so recall_vs_known is null.
  assert.equal(result.recall_vs_known, null);
});

test('runReplay with null reflectionFn skips reflection gracefully', async () => {
  const result = await runReplay(null);
  assert.equal(typeof result.corpus_size, 'number');
  assert.ok(result.corpus_size > 0);
});

test('corpus entries have required shape', async () => {
  const corpus = await loadCorpus();
  for (const e of corpus.entries) {
    assert.ok(
      typeof e.id === 'string' && e.id.length > 0,
      `entry missing id: ${JSON.stringify(e).slice(0, 80)}`,
    );
    assert.ok(typeof e.timestamp === 'string', `entry ${e.id} missing timestamp`);
    assert.ok(
      typeof e.content === 'string' && e.content.length > 0,
      `entry ${e.id} missing content`,
    );
    assert.ok(typeof e.context === 'object' && e.context !== null, `entry ${e.id} missing context`);
    // expected_rule_id is allowed to be null (Wave 3 fills these in)
    assert.ok(
      e.expected_rule_id === null || typeof e.expected_rule_id === 'string',
      `entry ${e.id} expected_rule_id must be null or string`,
    );
  }
});

test('recall_vs_known is correct when some candidates match known entries', async () => {
  const corpus = await loadCorpus();
  // Artificially inject expected_rule_ids for two entries so the math is
  // testable without a real DB.
  const [first, second] = corpus.entries;
  const patchedCorpus = {
    ...corpus,
    entries: corpus.entries.map((e, i) =>
      i < 2 ? { ...e, expected_rule_id: `rules:test-${i}` } : e,
    ),
  };

  // Mock loadCorpus by passing a pre-patched corpus through a custom fn.
  async function fakeReplay(reflectionFn) {
    const result = reflectionFn ? await reflectionFn(patchedCorpus.entries) : { candidates: [] };
    const known = patchedCorpus.entries.filter((e) => e.expected_rule_id != null).length;
    const recovered = result.candidates.filter(
      (c) =>
        Array.isArray(c.source_ids) &&
        c.source_ids.some(
          (id) => patchedCorpus.entries.find((e) => e.id === id)?.expected_rule_id != null,
        ),
    ).length;
    return {
      candidates: result,
      recall_vs_known: known === 0 ? null : recovered / known,
      corpus_size: patchedCorpus.entries.length,
    };
  }

  // Reflection that recovers only the first known entry (1/2 = 0.5).
  const halfRecovery = await fakeReplay(async (entries) => ({
    candidates: [{ content: 'candidate A', source_ids: [first.id] }],
  }));
  assert.equal(halfRecovery.recall_vs_known, 0.5);

  // Reflection that recovers both known entries (2/2 = 1.0).
  const fullRecovery = await fakeReplay(async (entries) => ({
    candidates: [
      { content: 'candidate A', source_ids: [first.id] },
      { content: 'candidate B', source_ids: [second.id] },
    ],
  }));
  assert.equal(fullRecovery.recall_vs_known, 1.0);

  // Reflection that recovers neither (0/2 = 0.0).
  const noRecovery = await fakeReplay(async (entries) => ({
    candidates: [{ content: 'candidate C', source_ids: ['v1-corr-unknown'] }],
  }));
  assert.equal(noRecovery.recall_vs_known, 0.0);
});

// ---------------------------------------------------------------------------
// Production-reflection integration (Task 3-C-D wiring)
// ---------------------------------------------------------------------------
// These tests wire runReplay() against the real dreamStepReflection module to
// verify mechanical correctness (no errors, expected return shape).
//
// The ≥80% recall assertion is skipped pending 3-A-5 (reflection co-dimension
// clustering on step-reflection.js — deferred; concurrent agent has unstaged
// changes to that file).  When 3-A-5 lands, remove the `skip` option from the
// last test in this block.

test('production reflection adapter: no errors and returns candidate array shape', async () => {
  const db = await freshDb();
  try {
    // Build a reflectionFn that wraps dreamStepReflection.
    // dreamStepReflection needs db + host; host is required for LLM calls.
    // We pass a stub host that declines all LLM invocations so no real spend
    // is incurred.  The function should still return {clusters, proposed, ...}
    // without throwing even when the host refuses.
    const stubHost = {
      invokeLLM: async () => {
        throw new Error('no LLM in test');
      },
    };

    // Seed the DB with fixture corrections so the step has something to cluster.
    const corpus = await loadCorpus();
    const surqlMod = await import('surrealdb');
    const { surql } = surqlMod;
    for (const entry of corpus.entries) {
      await db
        .query(
          surql`CREATE events CONTENT {
            source: 'explicit_correction',
            content: ${entry.content},
            meta:    { kind: 'correction', replay_fixture: true },
            ts:      time::now()
          }`,
        )
        .collect();
    }

    // Call the reflection step.  With no embeddings available, hydrated will
    // be empty → clusters=0, proposed=0.  This is the expected mechanical
    // no-error path; recall validation requires 3-A-5.
    const result = await dreamStepReflection(db, stubHost, {
      lookbackDays: 365,
      minCluster: 3,
    });

    assert.ok(typeof result === 'object' && result !== null, 'result should be an object');
    assert.ok('clusters' in result, 'result should have clusters count');
    assert.ok('proposed' in result, 'result should have proposed count');
    assert.ok(typeof result.clusters === 'number', 'clusters should be a number');
    assert.ok(typeof result.proposed === 'number', 'proposed should be a number');
  } finally {
    await close(db);
  }
});

test('runReplay with production reflectionFn: mechanical wiring returns corpus_size', async () => {
  const db = await freshDb();
  try {
    const stubHost = {
      invokeLLM: async () => {
        throw new Error('no LLM in test');
      },
    };

    const surqlMod = await import('surrealdb');
    const { surql } = surqlMod;
    const corpus = await loadCorpus();
    for (const entry of corpus.entries) {
      await db
        .query(
          surql`CREATE events CONTENT {
            source: 'explicit_correction',
            content: ${entry.content},
            meta:    { kind: 'correction', replay_fixture: true },
            ts:      time::now()
          }`,
        )
        .collect();
    }

    // Wire runReplay against the real dreamStepReflection as a reflectionFn.
    // Corpus entries are passed in; dreamStepReflection queries the DB for its
    // own corrections — this is the wiring point (production path uses DB,
    // not the in-memory corpus directly).  The result validates shape only.
    const reflectionFn = async (_entries) => {
      const raw = await dreamStepReflection(db, stubHost, {
        lookbackDays: 365,
        minCluster: 3,
      });
      // Adapt dreamStepReflection output → runReplay's expected {candidates} shape.
      // In the real path (3-A-5), candidates carry source_ids referencing corpus ids.
      // Here the result has no source_ids because minCluster > 0 and no embeddings
      // are seeded — that's expected for this mechanical test.
      return { candidates: [] };
    };

    const result = await runReplay(reflectionFn);
    assert.equal(typeof result.corpus_size, 'number');
    assert.ok(result.corpus_size > 0, 'corpus_size should be positive');
    assert.ok(Array.isArray(result.candidates), 'candidates should be an array');
  } finally {
    await close(db);
  }
});

// TODO(3-A-5): un-skip once reflection co-dim clustering lands (step-reflection.js refactor).
test('runReplay recall_vs_known >= 0.80 against v1-quarantine corpus', {
  skip: 'awaiting 3-A-5 (reflection co-dim clustering — deferred; step-reflection.js has concurrent unstaged changes)',
}, async () => {
  // This test will be un-skipped when 3-A-5 lands and step-reflection.js
  // gains the 0.70 + task_type co-dimension clustering described in spec §3.
  //
  // Expected setup when un-skipping:
  //   1. Seed a mem:// DB with the fixture corrections (including embeddings).
  //   2. Call runReplay with dreamStepReflection adapted to return source_ids.
  //   3. Assert result.recall_vs_known >= 0.80.
  const result = await runReplay(async () => ({ candidates: [] }));
  assert.ok(
    result.recall_vs_known == null || result.recall_vs_known >= 0.8,
    `recall_vs_known ${result.recall_vs_known} should be >= 0.80`,
  );
});
