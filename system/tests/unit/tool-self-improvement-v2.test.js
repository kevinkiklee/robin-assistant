// tests/unit/tool-self-improvement-v2.test.js
//
// Real implementation tests for the 8 MCP tools that replaced the Phase-1 stubs.
// Replaces system/tests/unit/tool-self-improvement-v2-stubs.test.js.
//
// Each tool is tested for:
//   - flag=false  → { ok: false, reason: 'v2_not_enabled' }
//   - flag=on, empty DB → reasonable empty-shape return
//   - flag=on, seeded data → expected shape with values
//   - schema validation / guard logic (e.g. invalid task_type, exactly-one-id)

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

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../data/db/migrations');

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, MIGRATIONS_DIR);
  return db;
}

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

// Valid args for flag-off tests — task_type must pass validateTaskType
const VALID_ARGS = {
  record_outcome: { task_type: 'job:daily-briefing', task_id: 'job:abc', signals: { quality: 0.9 } },
  propose_playbook: {
    task_type: 'job:daily-briefing',
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

// ── Tool metadata ────────────────────────────────────────────────────────────

test('all tools export name, description, inputSchema, handler', () => {
  const db = {};
  const tools = buildAll(db);
  for (const [name, tool] of Object.entries(tools)) {
    assert.equal(typeof tool.name, 'string', `${name}: name must be string`);
    assert.ok(tool.name.length > 0, `${name}: name must be non-empty`);
    assert.equal(typeof tool.description, 'string', `${name}: description must be string`);
    assert.ok(tool.description.length > 0, `${name}: description must be non-empty`);
    assert.equal(typeof tool.inputSchema, 'object', `${name}: inputSchema must be object`);
    assert.equal(tool.inputSchema.type, 'object', `${name}: inputSchema.type must be 'object'`);
    assert.equal(typeof tool.handler, 'function', `${name}: handler must be function`);
  }
});

// ── flag=false (default) ────────────────────────────────────────────────────

test('all tools: v2_not_enabled when flag is false', async () => {
  const db = await fresh();
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

// ── flag=true, empty DB ─────────────────────────────────────────────────────

test('list_playbooks: empty DB returns ok=true, playbooks=[]', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createListPlaybooksTool({ db });
  const result = await tool.handler({});
  assert.ok(result.ok);
  assert.deepEqual(result.playbooks, []);
  await close(db);
});

test('list_comm_style_snapshots: empty DB returns ok=true, snapshots=[]', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createListCommStyleSnapshotsTool({ db });
  const result = await tool.handler({});
  assert.ok(result.ok);
  assert.deepEqual(result.snapshots, []);
  await close(db);
});

test('get_calibration: empty DB returns ok=true, calibration={}', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createGetCalibrationTool({ db });
  const result = await tool.handler({});
  assert.ok(result.ok);
  assert.deepEqual(result.calibration, {});
  await close(db);
});

test('get_playbook: not_found on empty DB', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createGetPlaybookTool({ db });
  const result = await tool.handler({ id: 'memos:nonexistent123' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
  await close(db);
});

test('explain_playbook: not_found on empty DB', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createExplainPlaybookTool({ db });
  const result = await tool.handler({ id: 'memos:nonexistent123' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
  await close(db);
});

test('explain_learning: not_found for unknown memo', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createExplainLearningTool({ db });
  const result = await tool.handler({ memo_id: 'memos:doesnotexist' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
  await close(db);
});

// ── record_outcome ──────────────────────────────────────────────────────────

test('record_outcome: creates new memo on first call', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createRecordOutcomeTool({ db });
  const result = await tool.handler({
    task_type: 'job:daily-briefing',
    task_id: 'test-task-001',
    signals: { quality: 0.8 },
  });
  assert.ok(result.ok);
  assert.equal(result.action, 'created');
  assert.ok(result.id.startsWith('memos:'));
  await close(db);
});

test('record_outcome: idempotent update on second call same task_type+task_id', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createRecordOutcomeTool({ db });

  const first = await tool.handler({
    task_type: 'job:daily-briefing',
    task_id: 'test-task-idem',
    signals: { outcome_inference: { reason: 'first' } },
  });
  assert.equal(first.action, 'created');

  const second = await tool.handler({
    task_type: 'job:daily-briefing',
    task_id: 'test-task-idem',
    signals: { self_grade: 0.9 },
  });
  assert.equal(second.action, 'updated');
  assert.equal(first.id, second.id, 'ID should be the same memo');
  await close(db);
});

test('record_outcome: explicit_correction signal overrides score to 0', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createRecordOutcomeTool({ db });

  const result = await tool.handler({
    task_type: 'turn:default',
    task_id: 'turn-test-001',
    signals: { explicit_correction: { text: 'no, wrong' } },
  });
  assert.ok(result.ok);
  assert.equal(result.action, 'created');
  await close(db);
});

test('record_outcome: rejects invalid task_type', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createRecordOutcomeTool({ db });
  const result = await tool.handler({
    task_type: 'daily_brief',
    task_id: 'test-abc',
    signals: { quality: 0.9 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_task_type');
  await close(db);
});

test('record_outcome: accepts valid turn:default task_type', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createRecordOutcomeTool({ db });
  const result = await tool.handler({
    task_type: 'turn:default',
    task_id: 'turn-abc-001',
    signals: { self_grade: 0.85 },
  });
  assert.ok(result.ok);
  assert.equal(result.action, 'created');
  await close(db);
});

// ── propose_playbook ─────────────────────────────────────────────────────────

test('propose_playbook: creates v1 playbook when none exists', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createProposePlaybookTool({ db });
  const result = await tool.handler({
    task_type: 'job:daily-briefing',
    draft: 'Step 1: fetch data. Step 2: synthesize.',
    source_outcomes: ['memos:oc1', 'memos:oc2'],
  });
  assert.ok(result.ok);
  assert.equal(result.version, 1);
  assert.ok(result.id.startsWith('memos:'));
  assert.equal(result.supersedes, undefined);
  await close(db);
});

test('propose_playbook: supersedes existing active playbook and increments version', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createProposePlaybookTool({ db });

  const v1 = await tool.handler({
    task_type: 'job:health-trends',
    draft: 'v1 draft',
    source_outcomes: ['memos:oc1'],
  });
  assert.ok(v1.ok);
  assert.equal(v1.version, 1);

  const v2 = await tool.handler({
    task_type: 'job:health-trends',
    draft: 'v2 draft with improvements',
    source_outcomes: ['memos:oc1', 'memos:oc2', 'memos:oc3'],
  });
  assert.ok(v2.ok);
  assert.equal(v2.version, 2);
  assert.equal(v2.supersedes, v1.id);
  await close(db);
});

test('propose_playbook: rejects invalid task_type', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createProposePlaybookTool({ db });
  const result = await tool.handler({
    task_type: 'invalid:type',
    draft: 'some draft',
    source_outcomes: ['memos:x'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_task_type');
  await close(db);
});

test('propose_playbook: rejects frontmatter missing task_type', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createProposePlaybookTool({ db });
  const draftWithBadFm = '---\nversion: 1\n---\n\nBody here.';
  const result = await tool.handler({
    task_type: 'job:daily-briefing',
    draft: draftWithBadFm,
    source_outcomes: ['memos:x'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_frontmatter');
  await close(db);
});

test('propose_playbook: accepts draft without frontmatter block', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createProposePlaybookTool({ db });
  const result = await tool.handler({
    task_type: 'recall:default',
    draft: 'Just a body with no frontmatter.',
    source_outcomes: ['memos:x'],
  });
  assert.ok(result.ok);
  await close(db);
});

// ── list_playbooks ─────────────────────────────────────────────────────────

test('list_playbooks: returns seeded playbook with correct shape', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const propose = createProposePlaybookTool({ db });
  const list = createListPlaybooksTool({ db });

  await propose.handler({
    task_type: 'job:daily-briefing',
    draft: 'Step 1: do something.',
    source_outcomes: ['memos:oc1'],
  });

  const result = await list.handler({});
  assert.ok(result.ok);
  assert.equal(result.playbooks.length, 1);
  const pb = result.playbooks[0];
  assert.equal(pb.task_type, 'job:daily-briefing');
  assert.equal(pb.version, 1);
  assert.equal(pb.active, true);
  assert.ok(pb.id.startsWith('memos:'));
  await close(db);
});

test('list_playbooks: active_only=false returns all including superseded', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const propose = createProposePlaybookTool({ db });
  const list = createListPlaybooksTool({ db });

  await propose.handler({ task_type: 'job:daily-briefing', draft: 'v1', source_outcomes: ['memos:oc1'] });
  await propose.handler({ task_type: 'job:daily-briefing', draft: 'v2', source_outcomes: ['memos:oc2'] });

  const resultActive = await list.handler({ active_only: true });
  assert.equal(resultActive.playbooks.length, 1);

  const resultAll = await list.handler({ active_only: false });
  assert.equal(resultAll.playbooks.length, 2);
  await close(db);
});

test('list_playbooks: filters by task_type', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const propose = createProposePlaybookTool({ db });
  const list = createListPlaybooksTool({ db });

  await propose.handler({ task_type: 'job:daily-briefing', draft: 'pb1', source_outcomes: ['memos:a'] });
  await propose.handler({ task_type: 'recall:default', draft: 'pb2', source_outcomes: ['memos:b'] });

  const result = await list.handler({ task_type: 'job:daily-briefing' });
  assert.ok(result.ok);
  assert.equal(result.playbooks.length, 1);
  assert.equal(result.playbooks[0].task_type, 'job:daily-briefing');
  await close(db);
});

// ── get_playbook ────────────────────────────────────────────────────────────

test('get_playbook: returns full playbook by id', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const propose = createProposePlaybookTool({ db });
  const get = createGetPlaybookTool({ db });

  const { id } = await propose.handler({
    task_type: 'job:daily-briefing',
    draft: 'Step 1: fetch. Step 2: synthesize.',
    source_outcomes: ['memos:oc1'],
  });

  const result = await get.handler({ id });
  assert.ok(result.ok);
  assert.equal(result.playbook.id, id);
  assert.equal(result.playbook.kind, 'playbook');
  assert.ok(result.playbook.content.includes('Step 1'));
  assert.equal(result.playbook.meta.task_type, 'job:daily-briefing');
  await close(db);
});

// ── explain_playbook ─────────────────────────────────────────────────────────

test('explain_playbook: returns lineage for seeded playbook', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const propose = createProposePlaybookTool({ db });
  const explain = createExplainPlaybookTool({ db });

  const { id } = await propose.handler({
    task_type: 'job:daily-briefing',
    draft: 'Step 1: do stuff.',
    source_outcomes: ['memos:oc1', 'memos:oc2'],
  });

  const result = await explain.handler({ id });
  assert.ok(result.ok);
  assert.equal(result.playbook.id, id);
  assert.equal(result.playbook.meta.task_type, 'job:daily-briefing');
  assert.equal(result.prior_version, null);
  assert.ok(Array.isArray(result.source_outcomes.items));
  assert.ok(Array.isArray(result.cited_rules));
  await close(db);
});

test('explain_playbook: prior_version set after supersession', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const propose = createProposePlaybookTool({ db });
  const explain = createExplainPlaybookTool({ db });

  const v1 = await propose.handler({ task_type: 'job:daily-briefing', draft: 'v1', source_outcomes: ['memos:oc1'] });
  const v2 = await propose.handler({ task_type: 'job:daily-briefing', draft: 'v2', source_outcomes: ['memos:oc2'] });

  const result = await explain.handler({ id: v2.id });
  assert.ok(result.ok);
  assert.ok(result.prior_version !== null);
  assert.equal(result.prior_version.id, v1.id);
  await close(db);
});

// ── list_comm_style_snapshots ────────────────────────────────────────────────

test('list_comm_style_snapshots: accepts limit parameter', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createListCommStyleSnapshotsTool({ db });
  const result = await tool.handler({ limit: 5 });
  assert.ok(result.ok);
  assert.ok(Array.isArray(result.snapshots));
  await close(db);
});

test('list_comm_style_snapshots: default limit 20 works', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createListCommStyleSnapshotsTool({ db });
  const result = await tool.handler({});
  assert.ok(result.ok);
  assert.ok(Array.isArray(result.snapshots));
  await close(db);
});

// ── get_calibration ───────────────────────────────────────────────────────────

test('get_calibration: filters by statement_kind', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createGetCalibrationTool({ db });
  const result = await tool.handler({ statement_kind: 'event_timing' });
  assert.ok(result.ok);
  assert.equal(typeof result.calibration, 'object');
  // Empty for fresh DB
  assert.deepEqual(result.calibration, {});
  await close(db);
});

// ── explain_learning: guard logic ─────────────────────────────────────────────

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

test('explain_learning: exactly_one_id check fires before flag check', async () => {
  const db = await fresh();
  // flag is false by default
  const tool = createExplainLearningTool({ db });
  const result = await tool.handler({});
  // exactly_one_id fires first
  assert.equal(result.reason, 'exactly_one_id_required');
  await close(db);
});

test('explain_learning: v2_not_enabled with single valid id', async () => {
  const db = await fresh();
  const tool = createExplainLearningTool({ db });
  const result = await tool.handler({ memo_id: 'memos:m1' });
  assert.equal(result.reason, 'v2_not_enabled');
  await close(db);
});

test('explain_learning: dispatches playbook kind', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const propose = createProposePlaybookTool({ db });
  const explain = createExplainLearningTool({ db });

  const { id } = await propose.handler({
    task_type: 'job:daily-briefing',
    draft: 'Play: Step 1.',
    source_outcomes: ['memos:oc1'],
  });

  const result = await explain.handler({ memo_id: id });
  assert.ok(result.ok);
  assert.equal(result.kind, 'playbook');
  assert.ok(result.playbook);
  await close(db);
});

test('explain_learning: dispatches task_outcome kind', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const record = createRecordOutcomeTool({ db });
  const explain = createExplainLearningTool({ db });

  const { id } = await record.handler({
    task_type: 'turn:default',
    task_id: 'turn-explain-test',
    signals: { self_grade: 0.7 },
  });

  const result = await explain.handler({ memo_id: id });
  assert.ok(result.ok);
  assert.equal(result.kind, 'task_outcome');
  assert.ok(result.outcome);
  assert.equal(result.outcome.meta.task_type, 'turn:default');
  await close(db);
});

test('explain_learning: not_found for unknown rule_id', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createExplainLearningTool({ db });
  const result = await tool.handler({ rule_id: 'rules:doesnotexist' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
  await close(db);
});

test('explain_learning: not_found for unknown prediction_id', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const tool = createExplainLearningTool({ db });
  const result = await tool.handler({ prediction_id: 'memos:doesnotexist' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
  await close(db);
});
