// Snapshot test for recall: validates trimRecallEvents helper wiring.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';
import { createRecallTool } from '../../io/mcp/tools/recall.js';

const __robinTestHome = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function makeDetector() {
  return { check: () => ({ repeat: false }), observe: () => {} };
}

test('recall trims content beyond full-event window via trimRecallEvents', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Seed 8 events with the same query keyword "apple" so all match. The
  // first 5 should stay full, remainder should be truncated to 200 chars.
  const longText = 'apple ' + 'x'.repeat(500);
  for (let i = 0; i < 8; i++) {
    await recordEvent(db, e, { source: 'cli', content: longText + ` #${i}` });
  }
  const tool = createRecallTool({
    db,
    embedder: e,
    detector: makeDetector(),
    getSessionId: () => null,
  });
  const r = await tool.handler({ query: 'apple', limit: 8 });
  assert.equal(r.hits.length, 8);
  // First 5 untruncated (within budget); remainder truncated.
  const fullCount = r.hits.filter((h) => h.truncated === false).length;
  const truncCount = r.hits.filter((h) => h.truncated === true).length;
  assert.equal(fullCount + truncCount, 8);
  assert.ok(fullCount >= 1, 'expected at least one full event');
  assert.ok(truncCount >= 1, 'expected at least one truncated event');
  for (const h of r.hits.filter((x) => x.truncated)) {
    assert.ok(h.content.length <= 201, `truncated content too long: ${h.content.length}`);
    assert.ok(h.content.endsWith('…'), 'truncated content should end with ellipsis');
  }
  await close(db);
});

test('recall full:true returns untrimmed content', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const longText = 'apple ' + 'x'.repeat(500);
  for (let i = 0; i < 8; i++) {
    await recordEvent(db, e, { source: 'cli', content: longText + ` #${i}` });
  }
  const tool = createRecallTool({
    db,
    embedder: e,
    detector: makeDetector(),
    getSessionId: () => null,
  });
  const r = await tool.handler({ query: 'apple', limit: 8, full: true });
  assert.equal(r.hits.length, 8);
  // No truncated field on raw enriched hits.
  for (const h of r.hits) {
    assert.equal(h.truncated, undefined);
    assert.ok(h.content.length > 200);
  }
  await close(db);
});

test('recall respects snippet_budget_chars + snippet_per_event_max overrides', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const longText = 'apple ' + 'x'.repeat(300);
  for (let i = 0; i < 6; i++) {
    await recordEvent(db, e, { source: 'cli', content: longText + ` #${i}` });
  }
  const tool = createRecallTool({
    db,
    embedder: e,
    detector: makeDetector(),
    getSessionId: () => null,
  });
  // Tight budget — 1 event full, rest truncated to 50.
  const r = await tool.handler({
    query: 'apple',
    limit: 6,
    snippet_budget_chars: 400,
    snippet_per_event_max: 50,
  });
  const truncs = r.hits.filter((h) => h.truncated === true);
  for (const h of truncs) {
    assert.ok(h.content.length <= 51, `expected ≤51 chars, got ${h.content.length}`);
  }
  await close(db);
});
