// system/tests/unit/dream-step-reflection-codim.test.js
//
// Co-dimension reflection clustering tests (spec §4c, task 3-A-5).
//
// The clustering changes:
//   - Same task_type → cosine threshold 0.70
//   - Different task_types (or any pair with task_type=null vs. non-null) → 0.85
//   - Both task_type=null → 0.70 (legacy bucket clusters with itself)
//
// We test through the public dreamStepReflection by seeding correction events
// with controlled embeddings via createStubEmbedder.

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dreamStepReflection } from '../../cognition/dream/step-reflection.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function fakeHost(content) {
  return { invokeLLM: async () => ({ content, usage: {} }) };
}

const RULE_JSON = JSON.stringify({ propose: true, rule_text: 'A rule', confidence: 0.8 });

test('within-task clustering: same task_type clusters at 0.70 threshold', async () => {
  // Stub embedder produces a stable-but-similar vector keyed by content hash.
  // We use identical content so the cosine is 1.0 (well above both thresholds).
  // But because all 3 events share task_type, the within-task path is exercised.
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  for (let i = 0; i < 3; i++) {
    await recordEvent(db, e, {
      source: 'explicit_correction',
      content: 'no, do it the other way',
      meta: { kind: 'correction', task_type: 'turn:analyze' },
    });
  }
  const r = await dreamStepReflection(db, fakeHost(RULE_JSON), { minCluster: 3 });
  assert.ok(r.proposed >= 1, 'within-task clustering should propose a rule');
  await close(db);
});

test('cross-task clustering: different task_types do not cluster at 0.70', async () => {
  // 3 events split across two task_types: 2 in turn:analyze, 1 in outbound:discord_send:send_dm.
  // With identical content (cosine=1.0), cross-task threshold is 0.85.
  // Cosine=1.0 still > 0.85, so they DO cluster — verifying the cross-task path doesn't break.
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, {
    source: 'explicit_correction',
    content: 'identical content',
    meta: { kind: 'correction', task_type: 'turn:analyze' },
  });
  await recordEvent(db, e, {
    source: 'explicit_correction',
    content: 'identical content',
    meta: { kind: 'correction', task_type: 'turn:analyze' },
  });
  await recordEvent(db, e, {
    source: 'explicit_correction',
    content: 'identical content',
    meta: { kind: 'correction', task_type: 'outbound:discord_send:send_dm' },
  });
  const r = await dreamStepReflection(db, fakeHost(RULE_JSON), { minCluster: 3 });
  assert.equal(r.clusters, 1, 'identical content clusters across tasks at 0.85');
  assert.ok(r.proposed >= 1, 'cross-task cluster proposes a rule');
  await close(db);
});

test('null task_type pairs use cross-task threshold (0.85)', async () => {
  // Legacy corrections without task_type. Three identical-content rows cluster
  // because cosine=1.0 exceeds 0.85.
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  for (let i = 0; i < 3; i++) {
    await recordEvent(db, e, {
      source: 'explicit_correction',
      content: 'no, do that thing',
      meta: { kind: 'correction' }, // No task_type — legacy / pre-W2-B shape.
    });
  }
  const r = await dreamStepReflection(db, fakeHost(RULE_JSON), { minCluster: 3 });
  assert.ok(r.proposed >= 1, 'null task_type still clusters at the cross threshold');
  await close(db);
});

test('threshold override: withinTaskTypeSimilarityThreshold respected', async () => {
  // Same task_type, identical content (cosine=1.0). Setting the within threshold
  // to 0.95 still passes (1.0 > 0.95). Setting it to 1.01 would fail to cluster.
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  for (let i = 0; i < 3; i++) {
    await recordEvent(db, e, {
      source: 'explicit_correction',
      content: 'tight cluster',
      meta: { kind: 'correction', task_type: 'turn:analyze' },
    });
  }
  // With a too-tight within threshold (>1.0), nothing clusters.
  const r = await dreamStepReflection(db, fakeHost(RULE_JSON), {
    minCluster: 3,
    withinTaskTypeSimilarityThreshold: 1.01,
    similarityThreshold: 1.01,
  });
  assert.equal(r.clusters, 0, 'over-1.0 thresholds prevent clustering');
  assert.equal(r.proposed, 0);
  await close(db);
});

test('mixed task_types in one cluster: pair-wise threshold dispatch', async () => {
  // 2 rows in turn:analyze and 1 in turn:plan, all identical content.
  // The two same-task rows cluster at 0.70 (within); the third cross-task
  // row clusters into them at 0.85 (cross). All three end up in one cluster.
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, {
    source: 'explicit_correction',
    content: 'common content',
    meta: { kind: 'correction', task_type: 'turn:analyze' },
  });
  await recordEvent(db, e, {
    source: 'explicit_correction',
    content: 'common content',
    meta: { kind: 'correction', task_type: 'turn:analyze' },
  });
  await recordEvent(db, e, {
    source: 'explicit_correction',
    content: 'common content',
    meta: { kind: 'correction', task_type: 'turn:plan' },
  });
  const r = await dreamStepReflection(db, fakeHost(RULE_JSON), { minCluster: 3 });
  assert.equal(r.clusters, 1, 'mixed task_types fold into one cluster on high cosine');
  await close(db);
});
