// Tests for the B-candidate moves applied as part of the framework rollout:
//
// B-2: mcp.wiring_global_present is now detection-only. No repair function.
// B-5: robin embeddings activate refuses unless backfill is complete; --force
//      bypasses for operators in dual-read / known-partial state.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../../config/paths.js';
import { close, connect } from '../../../data/db/client.js';
import { runMigrations } from '../../../data/db/migrate.js';
import { dispatch } from '../../../cognition/jobs/embeddings-ops.js';
import mcpWiringGlobalPresent from '../../../runtime/invariants/mcp.wiring-global-present.js';

const tmpRoot = join(tmpdir(), `robin-bx-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(tmpRoot, { recursive: true });
process.env.ROBIN_HOME = tmpRoot;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../../data/db/migrations'));
  return db;
}

// --- B-2: detection-only ---

test('B-2: mcp.wiring_global_present has no repair function', () => {
  assert.equal(mcpWiringGlobalPresent.repair, undefined);
});

test('B-2: explain mentions the manual fix', () => {
  const md = mcpWiringGlobalPresent.explain();
  assert.ok(md.includes('Fix (manual)'), 'explain should call out manual fix');
  assert.ok(md.includes('"type": "sse"'), 'explain should include the canonical entry');
});

// --- B-5: atomic embedder profile swap ---

test('B-5: activate refuses when target profile tables missing', async () => {
  const db = await fresh();
  try {
    // Use a non-default profile so migrations haven't created its tables
    const r = await dispatch(db, { op: 'activate', profile: 'qwen3-4096' });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /tables missing/);
  } finally {
    await close(db);
  }
});

test('B-5: activate refuses when backfill incomplete (events row, no embedding)', async () => {
  const db = await fresh();
  try {
    // Prepare profile tables
    await dispatch(db, { op: 'prepare', profile: 'mxbai-1024' });
    // Insert an event without a corresponding embedding row
    await db
      .query("CREATE events:test_event SET content = 'test', source = 'test', ts = time::now();")
      .collect();
    // Activate should refuse
    const r = await dispatch(db, { op: 'activate', profile: 'mxbai-1024' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'backfill_incomplete');
    assert.ok(Array.isArray(r.gaps));
    const eventsGap = r.gaps.find((g) => g.surface === 'events');
    assert.ok(eventsGap, 'events surface should appear in gaps');
    assert.equal(eventsGap.source_count, 1);
    assert.equal(eventsGap.target_count, 0);
    assert.ok(r.hint?.includes('robin embeddings backfill') || r.hint?.includes('--force'));
  } finally {
    await close(db);
  }
});

test('B-5: activate passes when source tables empty (fresh install)', async () => {
  const db = await fresh();
  try {
    await dispatch(db, { op: 'prepare', profile: 'mxbai-1024' });
    const r = await dispatch(db, { op: 'activate', profile: 'mxbai-1024' });
    assert.equal(r.ok, true);
  } finally {
    await close(db);
  }
});

test('B-5: activate with force=true bypasses the backfill check', async () => {
  const db = await fresh();
  try {
    await dispatch(db, { op: 'prepare', profile: 'mxbai-1024' });
    await db
      .query("CREATE events:test_force SET content = 'test', source = 'test', ts = time::now();")
      .collect();
    const r = await dispatch(db, { op: 'activate', profile: 'mxbai-1024', force: true });
    assert.equal(r.ok, true);
  } finally {
    await close(db);
  }
});
