import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamProcess } from '../../src/dream/pipeline.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createGetHotTool } from '../../src/mcp/tools/get-hot.js';
import { createGetKnowledgeTool } from '../../src/mcp/tools/get-knowledge.js';
import { createGetProfileTool } from '../../src/mcp/tools/get-profile.js';
import { createListJournalTool } from '../../src/mcp/tools/list-journal.js';
import { createListPatternsTool } from '../../src/mcp/tools/list-patterns.js';
import { createListRulesTool } from '../../src/mcp/tools/list-rules.js';
import { createListThreadsTool } from '../../src/mcp/tools/list-threads.js';
import { createRunDreamTool } from '../../src/mcp/tools/run-dream.js';
import { createUpdateRuleTool } from '../../src/mcp/tools/update-rule.js';
import { createCandidate } from '../../src/rules/candidates.js';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

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

test('all 8 read/update tools have correct names + schemas + handlers run on empty DB', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const tools = [
    createGetKnowledgeTool({ db, embedder: e }),
    createListPatternsTool({ db }),
    createGetProfileTool({ db }),
    createListThreadsTool({ db }),
    createListJournalTool({ db }),
    createGetHotTool({ db }),
    createListRulesTool({ db }),
    createUpdateRuleTool({ db }),
  ];
  const expectedNames = [
    'get_knowledge',
    'list_patterns',
    'get_profile',
    'list_threads',
    'list_journal',
    'get_hot',
    'list_rules',
    'update_rule',
  ];
  tools.forEach((t, i) => {
    assert.equal(t.name, expectedNames[i]);
    assert.ok(t.description);
    assert.ok(t.inputSchema);
    assert.equal(typeof t.handler, 'function');
  });

  // Empty-DB smoke: every read tool succeeds with no args.
  const k = await tools[0].handler({});
  assert.deepEqual(k, { knowledge: [] });
  const p = await tools[1].handler({});
  assert.deepEqual(p, { patterns: [] });
  const prof = await tools[2].handler({});
  // The schema seeds persona:singleton so commstyle reads have a deterministic
  // target. Empty-shaped on a fresh DB.
  if (prof.profile === null) {
    assert.deepEqual(prof, { profile: null });
  } else {
    assert.equal(prof.profile.id, 'persona:singleton');
    assert.equal(prof.profile.name, undefined);
    assert.equal(prof.profile.display_name, undefined);
  }
  const th = await tools[3].handler({});
  assert.deepEqual(th, { threads: [] });
  const j = await tools[4].handler({});
  assert.deepEqual(j, { entries: [] });
  const h = await tools[5].handler({});
  assert.deepEqual(h, { episodes: [], recent_events: [], entities: [] });
  const r = await tools[6].handler({});
  assert.deepEqual(r, { active: [] });

  // update_rule on a missing candidate must fail (approve reads first).
  await assert.rejects(tools[7].handler({ id: 'nope', action: 'approve' }));
  await close(db);
});

test('get_knowledge with query argument exercises the search path', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const tool = createGetKnowledgeTool({ db, embedder: e });
  const r = await tool.handler({ query: 'anything', limit: 5 });
  assert.deepEqual(r, { knowledge: [] });
  await close(db);
});

test('list_rules with status=all returns both buckets', async () => {
  const db = await fresh();
  const tool = createListRulesTool({ db });
  const r = await tool.handler({ status: 'all' });
  assert.ok(Array.isArray(r.active));
  assert.ok(Array.isArray(r.pending));
  await close(db);
});

test('update_rule approve happy path against a real candidate', async () => {
  const db = await fresh();
  const cand = await createCandidate(db, {
    content: 'be more terse in summaries',
    kind: 'behavior',
    signal_events: [],
  });
  const tool = createUpdateRuleTool({ db });
  const r = await tool.handler({ id: cand.id, action: 'approve' });
  assert.equal(r.ok, true);
  assert.ok(r.rule_id);
  await close(db);
});

test('update_rule reject records reason on the candidate', async () => {
  const db = await fresh();
  const cand = await createCandidate(db, {
    content: 'a bad idea',
    kind: 'behavior',
    signal_events: [],
  });
  const tool = createUpdateRuleTool({ db });
  const r = await tool.handler({
    id: cand.id,
    action: 'reject',
    options: { reason: 'noisy' },
  });
  assert.equal(r.ok, true);
  await close(db);
});

test('update_rule deactivate flips active=false on the rule row', async () => {
  const db = await fresh();
  // Create a candidate, approve to materialize a rules row, then deactivate it.
  const cand = await createCandidate(db, {
    content: 'rule to be deactivated',
    kind: 'behavior',
    signal_events: [],
  });
  const tool = createUpdateRuleTool({ db });
  const approved = await tool.handler({ id: cand.id, action: 'approve' });
  const r = await tool.handler({ id: approved.rule_id, action: 'deactivate' });
  assert.equal(r.ok, true);
  const [rows] = await db
    .query(surql`SELECT active FROM type::record('rules', ${approved.rule_id.split(':')[1]})`)
    .collect();
  assert.equal(rows[0].active, false);
  await close(db);
});

test('update_rule set_priority requires an integer priority', async () => {
  const db = await fresh();
  const cand = await createCandidate(db, {
    content: 'rule priority test',
    kind: 'behavior',
    signal_events: [],
  });
  const tool = createUpdateRuleTool({ db });
  const approved = await tool.handler({ id: cand.id, action: 'approve' });

  // Missing priority → throws.
  await assert.rejects(tool.handler({ id: approved.rule_id, action: 'set_priority' }));

  // Valid priority → succeeds.
  const ok = await tool.handler({
    id: approved.rule_id,
    action: 'set_priority',
    options: { priority: 42 },
  });
  assert.equal(ok.ok, true);
  await close(db);
});

test('update_rule rejects unknown actions', async () => {
  const db = await fresh();
  const tool = createUpdateRuleTool({ db });
  await assert.rejects(tool.handler({ id: 'rules:abc', action: 'whatever' }));
  await close(db);
});

test('run_dream wraps dreamProcess and returns its summary', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const host = { invokeLLM: async () => ({ content: '{}', usage: {} }) };
  const tool = createRunDreamTool({ db, host, embedder: e, dreamProcess });
  const r = await tool.handler({});
  assert.ok(r.summary);
  // Pipeline always emits step buckets, even if they're errors or 0-counts.
  assert.ok('knowledge' in r.summary);
  assert.ok('patterns' in r.summary);
  assert.ok('reflection' in r.summary);
  assert.ok('profile' in r.summary);
  assert.ok('threads' in r.summary);
  await close(db);
});
