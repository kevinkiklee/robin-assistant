import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamStepCorrections } from '../../src/dream/step-corrections.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

function fakeHost(content) {
  return { invokeLLM: async () => ({ content, usage: {} }) };
}

test('dreamStepCorrections proposes a rule when 3+ similar corrections cluster', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
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
  const r = await dreamStepCorrections(db, host, { minCluster: 3, similarityThreshold: 0.85 });
  assert.ok(r.proposed >= 1);
  await close(db);
});
