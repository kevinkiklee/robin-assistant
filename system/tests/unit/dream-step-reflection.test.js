import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
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
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

function fakeHost(content) {
  return { invokeLLM: async () => ({ content, usage: {} }) };
}

test('dreamStepReflection proposes a rule when 3+ similar corrections cluster', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Identical content → identical stub vectors → cosine = 1.0 → trivially clusters.
  for (let i = 0; i < 3; i++) {
    await recordEvent(db, e, {
      source: 'manual',
      content: 'be more concise',
      meta: { kind: 'correction' },
    });
  }
  const host = fakeHost(
    JSON.stringify({ propose: true, rule_text: 'Prefer concise responses', confidence: 0.9 }),
  );
  const r = await dreamStepReflection(db, host, { minCluster: 3, similarityThreshold: 0.85 });
  assert.ok(r.proposed >= 1);
  await close(db);
});
