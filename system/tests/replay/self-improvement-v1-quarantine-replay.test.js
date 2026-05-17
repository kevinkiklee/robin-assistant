// system/tests/replay/self-improvement-v1-quarantine-replay.test.js
//
// Phase 3 replay-validation harness skeleton (Task W1-D).
//
// Full validation (Wave 3) replaces the no-op reflectionFn with the real
// reflection clustering module and checks that runReplay() returns
// recall_vs_known >= 0.80 against the ~30 fixture entries sampled from the
// v1 import corpus.
//
// Run via: pnpm test:file system/tests/replay/self-improvement-v1-quarantine-replay.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(__dirname, 'fixtures/v1-quarantine-corrections.json');

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
  const result = reflectionFn
    ? await reflectionFn(corpus.entries)
    : { candidates: [] };
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];

  const known = corpus.entries.filter((e) => e.expected_rule_id != null).length;
  const recovered = candidates.filter((c) =>
    Array.isArray(c.source_ids) &&
    c.source_ids.some((id) =>
      corpus.entries.find((e) => e.id === id)?.expected_rule_id != null
    )
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
  assert.ok(typeof corpus.entries[0].content === 'string', 'first entry should have string content');
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
    assert.ok(typeof e.id === 'string' && e.id.length > 0, `entry missing id: ${JSON.stringify(e).slice(0, 80)}`);
    assert.ok(typeof e.timestamp === 'string', `entry ${e.id} missing timestamp`);
    assert.ok(typeof e.content === 'string' && e.content.length > 0, `entry ${e.id} missing content`);
    assert.ok(typeof e.context === 'object' && e.context !== null, `entry ${e.id} missing context`);
    // expected_rule_id is allowed to be null (Wave 3 fills these in)
    assert.ok(
      e.expected_rule_id === null || typeof e.expected_rule_id === 'string',
      `entry ${e.id} expected_rule_id must be null or string`
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
      i < 2 ? { ...e, expected_rule_id: `rules:test-${i}` } : e
    ),
  };

  // Mock loadCorpus by passing a pre-patched corpus through a custom fn.
  async function fakeReplay(reflectionFn) {
    const result = reflectionFn
      ? await reflectionFn(patchedCorpus.entries)
      : { candidates: [] };
    const known = patchedCorpus.entries.filter((e) => e.expected_rule_id != null).length;
    const recovered = result.candidates.filter((c) =>
      Array.isArray(c.source_ids) &&
      c.source_ids.some((id) =>
        patchedCorpus.entries.find((e) => e.id === id)?.expected_rule_id != null
      )
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
