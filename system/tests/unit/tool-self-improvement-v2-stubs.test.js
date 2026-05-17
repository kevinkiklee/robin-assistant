// tests/unit/tool-self-improvement-v2-stubs.test.js
//
// Verifies all 8 Phase-1 MCP tool stubs:
//   - flag=false  → { ok: false, reason: 'v2_not_enabled' }
//   - flag=true   → { ok: false, reason: 'not_implemented_yet', stub: true }
//   - schema validation: malformed input is rejected by inputSchema shape checks
//     (these are synchronous contract tests; real schema validation is done by
//     the MCP server layer, not the handler itself, so we test the handler's
//     own guard logic where it exists, e.g. explain-learning's exactly-one check)

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createExplainLearningTool } from '../../io/mcp/tools/explain-learning.js';
import { createExplainPlaybookTool } from '../../io/mcp/tools/explain-playbook.js';
import { createGetCalibrationTool } from '../../io/mcp/tools/get-calibration.js';
import { createGetPlaybookTool } from '../../io/mcp/tools/get-playbook.js';
import { createListCommStyleSnapshotsTool } from '../../io/mcp/tools/list-comm-style-snapshots.js';
import { createListPlaybooksTool } from '../../io/mcp/tools/list-playbooks.js';
import { createProposePlaybookTool } from '../../io/mcp/tools/propose-playbook.js';
import { createRecordOutcomeTool } from '../../io/mcp/tools/record-outcome.js';
import { setSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

// Helper: build all 8 tools from a single db
function buildAll(db) {
  return {
    record_outcome: createRecordOutcomeTool({ db }),
    propose_playbook: createProposePlaybookTool({ db }),
    list_playbooks: createListPlaybooksTool({ db }),
    get_playbook: createGetPlaybookTool({ db }),
    explain_playbook: createExplainPlaybookTool({ db }),
    list_comm_style_snapshots: createListCommStyleSnapshotsTool({ db }),
    get_calibration: createGetCalibrationTool({ db }),
    explain_learning: createExplainLearningTool({ db }),
  };
}

// Minimal valid args for each tool
const VALID_ARGS = {
  record_outcome: { task_type: 'daily_brief', task_id: 'job:abc', signals: { quality: 0.9 } },
  propose_playbook: {
    task_type: 'daily_brief',
    draft: 'Step 1: do X. Step 2: do Y.',
    source_outcomes: ['memos:abc123'],
  },
  list_playbooks: {},
  get_playbook: { id: 'memos:pb1' },
  explain_playbook: { id: 'memos:pb1' },
  list_comm_style_snapshots: {},
  get_calibration: {},
  explain_learning: { memo_id: 'memos:m1' },
};

// ── flag=false (default) ────────────────────────────────────────────────────

test('all stubs return v2_not_enabled when flag is false', async () => {
  const db = await fresh();
  // flag is false by default — no upsert needed
  const tools = buildAll(db);
  for (const [name, tool] of Object.entries(tools)) {
    const result = await tool.handler(VALID_ARGS[name]);
    assert.deepEqual(
      result,
      { ok: false, reason: 'v2_not_enabled' },
      `${name}: expected v2_not_enabled`,
    );
  }
  await close(db);
});

// ── flag=true ───────────────────────────────────────────────────────────────

test('all stubs return not_implemented_yet when flag is true', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tools = buildAll(db);
  for (const [name, tool] of Object.entries(tools)) {
    const result = await tool.handler(VALID_ARGS[name]);
    assert.deepEqual(
      result,
      { ok: false, reason: 'not_implemented_yet', stub: true },
      `${name}: expected not_implemented_yet`,
    );
  }
  await close(db);
});

// ── per-tool flag=false ─────────────────────────────────────────────────────
// Individual tests so failures are easy to pin

test('record_outcome: v2_not_enabled', async () => {
  const db = await fresh();
  const tool = createRecordOutcomeTool({ db });
  assert.deepEqual(await tool.handler(VALID_ARGS.record_outcome), {
    ok: false,
    reason: 'v2_not_enabled',
  });
  await close(db);
});

test('propose_playbook: v2_not_enabled', async () => {
  const db = await fresh();
  const tool = createProposePlaybookTool({ db });
  assert.deepEqual(await tool.handler(VALID_ARGS.propose_playbook), {
    ok: false,
    reason: 'v2_not_enabled',
  });
  await close(db);
});

test('list_playbooks: v2_not_enabled', async () => {
  const db = await fresh();
  const tool = createListPlaybooksTool({ db });
  assert.deepEqual(await tool.handler({}), { ok: false, reason: 'v2_not_enabled' });
  await close(db);
});

test('get_playbook: v2_not_enabled', async () => {
  const db = await fresh();
  const tool = createGetPlaybookTool({ db });
  assert.deepEqual(await tool.handler({ id: 'memos:x' }), { ok: false, reason: 'v2_not_enabled' });
  await close(db);
});

test('explain_playbook: v2_not_enabled', async () => {
  const db = await fresh();
  const tool = createExplainPlaybookTool({ db });
  assert.deepEqual(await tool.handler({ id: 'memos:x' }), { ok: false, reason: 'v2_not_enabled' });
  await close(db);
});

test('list_comm_style_snapshots: v2_not_enabled', async () => {
  const db = await fresh();
  const tool = createListCommStyleSnapshotsTool({ db });
  assert.deepEqual(await tool.handler({}), { ok: false, reason: 'v2_not_enabled' });
  await close(db);
});

test('get_calibration: v2_not_enabled', async () => {
  const db = await fresh();
  const tool = createGetCalibrationTool({ db });
  assert.deepEqual(await tool.handler({}), { ok: false, reason: 'v2_not_enabled' });
  await close(db);
});

test('explain_learning: v2_not_enabled', async () => {
  const db = await fresh();
  const tool = createExplainLearningTool({ db });
  assert.deepEqual(await tool.handler({ memo_id: 'memos:m1' }), {
    ok: false,
    reason: 'v2_not_enabled',
  });
  await close(db);
});

// ── per-tool flag=true ──────────────────────────────────────────────────────

test('record_outcome: not_implemented_yet', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createRecordOutcomeTool({ db });
  assert.deepEqual(await tool.handler(VALID_ARGS.record_outcome), {
    ok: false,
    reason: 'not_implemented_yet',
    stub: true,
  });
  await close(db);
});

test('propose_playbook: not_implemented_yet', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createProposePlaybookTool({ db });
  assert.deepEqual(await tool.handler(VALID_ARGS.propose_playbook), {
    ok: false,
    reason: 'not_implemented_yet',
    stub: true,
  });
  await close(db);
});

test('list_playbooks: not_implemented_yet', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createListPlaybooksTool({ db });
  assert.deepEqual(await tool.handler({}), {
    ok: false,
    reason: 'not_implemented_yet',
    stub: true,
  });
  await close(db);
});

test('get_playbook: not_implemented_yet', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createGetPlaybookTool({ db });
  assert.deepEqual(await tool.handler({ id: 'memos:x' }), {
    ok: false,
    reason: 'not_implemented_yet',
    stub: true,
  });
  await close(db);
});

test('explain_playbook: not_implemented_yet', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createExplainPlaybookTool({ db });
  assert.deepEqual(await tool.handler({ id: 'memos:x' }), {
    ok: false,
    reason: 'not_implemented_yet',
    stub: true,
  });
  await close(db);
});

test('list_comm_style_snapshots: not_implemented_yet', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createListCommStyleSnapshotsTool({ db });
  assert.deepEqual(await tool.handler({}), {
    ok: false,
    reason: 'not_implemented_yet',
    stub: true,
  });
  await close(db);
});

test('get_calibration: not_implemented_yet', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createGetCalibrationTool({ db });
  assert.deepEqual(await tool.handler({}), {
    ok: false,
    reason: 'not_implemented_yet',
    stub: true,
  });
  await close(db);
});

test('explain_learning: not_implemented_yet', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createExplainLearningTool({ db });
  assert.deepEqual(await tool.handler({ memo_id: 'memos:m1' }), {
    ok: false,
    reason: 'not_implemented_yet',
    stub: true,
  });
  await close(db);
});

// ── inputSchema shape checks ────────────────────────────────────────────────
// The MCP server validates inputSchema at the protocol layer; here we test
// the handler's own guard logic (explain_learning's exactly-one-id check).

test('explain_learning: rejects when no id provided', async () => {
  const db = await fresh();
  const tool = createExplainLearningTool({ db });
  const result = await tool.handler({});
  assert.deepEqual(result, { ok: false, reason: 'exactly_one_id_required' });
  await close(db);
});

test('explain_learning: rejects when multiple ids provided', async () => {
  const db = await fresh();
  const tool = createExplainLearningTool({ db });
  const result = await tool.handler({ memo_id: 'memos:a', rule_id: 'rules:b' });
  assert.deepEqual(result, { ok: false, reason: 'exactly_one_id_required' });
  await close(db);
});

test('explain_learning: accepts memo_id alone', async () => {
  const db = await fresh();
  // flag false → v2_not_enabled (but the exactly-one guard passed)
  const tool = createExplainLearningTool({ db });
  const result = await tool.handler({ memo_id: 'memos:m1' });
  assert.equal(result.reason, 'v2_not_enabled');
  await close(db);
});

test('explain_learning: accepts rule_id alone', async () => {
  const db = await fresh();
  const tool = createExplainLearningTool({ db });
  const result = await tool.handler({ rule_id: 'rules:r1' });
  assert.equal(result.reason, 'v2_not_enabled');
  await close(db);
});

test('explain_learning: accepts prediction_id alone', async () => {
  const db = await fresh();
  const tool = createExplainLearningTool({ db });
  const result = await tool.handler({ prediction_id: 'memos:p1' });
  assert.equal(result.reason, 'v2_not_enabled');
  await close(db);
});

// Tool metadata checks: name and inputSchema presence

test('all tools export name and inputSchema', () => {
  // Use a stub db (won't be called in handler)
  const stubDb = {};
  const tools = buildAll(stubDb);
  for (const [name, tool] of Object.entries(tools)) {
    assert.equal(typeof tool.name, 'string', `${name}: tool.name must be a string`);
    assert.ok(tool.name.length > 0, `${name}: tool.name must be non-empty`);
    assert.equal(typeof tool.description, 'string', `${name}: description must be a string`);
    assert.ok(tool.description.length > 0, `${name}: description must be non-empty`);
    assert.equal(typeof tool.inputSchema, 'object', `${name}: inputSchema must be an object`);
    assert.equal(tool.inputSchema.type, 'object', `${name}: inputSchema.type must be 'object'`);
    assert.equal(typeof tool.handler, 'function', `${name}: handler must be a function`);
  }
});
