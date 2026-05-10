import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getProfile } from '../../src/memory/profile.js';
import { createCandidate, listCandidates } from '../../src/rules/candidates.js';
import {
  approveCandidate,
  deactivateRule,
  listRules,
  rejectCandidate,
  setRulePriority,
} from '../../src/rules/rules.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
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

test('approveCandidate (behavior) creates active rule', async () => {
  const db = await fresh();
  const c = await createCandidate(db, {
    content: 'be concise',
    kind: 'behavior',
    signal_events: [],
    confidence: 0.9,
  });
  const r = await approveCandidate(db, c.id);
  assert.ok(r.id);
  const rules = await listRules(db);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].active, true);
  assert.equal(rules[0].kind, 'behavior');

  // Candidate should be marked approved
  const approved = await listCandidates(db, { status: 'approved' });
  assert.equal(approved.length, 1);
  assert.equal(approved[0].content, 'be concise');
  await close(db);
});

test('approveCandidate (profile_update) applies payload to profile', async () => {
  const db = await fresh();
  const c = await createCandidate(db, {
    content: 'name is Kevin',
    kind: 'profile_update',
    signal_events: [],
    payload: { fields: { name: 'Kevin' } },
    confidence: 0.9,
  });
  await approveCandidate(db, c.id);
  const p = await getProfile(db);
  assert.equal(p.name, 'Kevin');

  // History row preserved with kind='profile_update'
  const rules = await listRules(db);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].kind, 'profile_update');
  await close(db);
});

test('approveCandidate (conflict_warning) narrows kind to behavior', async () => {
  const db = await fresh();
  const c = await createCandidate(db, {
    content: 'fact A vs fact B disagree',
    kind: 'conflict_warning',
    signal_events: [],
    confidence: 0.6,
  });
  await approveCandidate(db, c.id);
  const rules = await listRules(db);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].kind, 'behavior');
  await close(db);
});

test('rejectCandidate marks rejected; no rules row created', async () => {
  const db = await fresh();
  const c = await createCandidate(db, {
    content: 'x',
    kind: 'behavior',
    signal_events: [],
    confidence: 0.5,
  });
  await rejectCandidate(db, c.id, 'no thanks');
  const rules = await listRules(db);
  assert.equal(rules.length, 0);
  const rejected = await listCandidates(db, { status: 'rejected' });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].rejected_reason, 'no thanks');
  await close(db);
});

test('setRulePriority updates and lists order', async () => {
  const db = await fresh();
  const c = await createCandidate(db, {
    content: 'r',
    kind: 'behavior',
    signal_events: [],
    confidence: 0.9,
  });
  const r = await approveCandidate(db, c.id);
  await setRulePriority(db, r.id, 90);
  const rules = await listRules(db);
  assert.equal(rules[0].priority, 90);
  await close(db);
});

test('setRulePriority rejects out-of-range values', async () => {
  const db = await fresh();
  const c = await createCandidate(db, {
    content: 'r',
    kind: 'behavior',
    signal_events: [],
    confidence: 0.9,
  });
  const r = await approveCandidate(db, c.id);
  await assert.rejects(() => setRulePriority(db, r.id, 0), /priority must be int 1\.\.100/);
  await assert.rejects(() => setRulePriority(db, r.id, 101), /priority must be int 1\.\.100/);
  await assert.rejects(() => setRulePriority(db, r.id, 1.5), /priority must be int 1\.\.100/);
  await close(db);
});

test('deactivateRule sets active=false', async () => {
  const db = await fresh();
  const c = await createCandidate(db, {
    content: 'r',
    kind: 'behavior',
    signal_events: [],
    confidence: 0.9,
  });
  const r = await approveCandidate(db, c.id);
  await deactivateRule(db, r.id);
  const rules = await listRules(db, { activeOnly: true });
  assert.equal(rules.length, 0);
  // But still visible when activeOnly=false
  const all = await listRules(db, { activeOnly: false });
  assert.equal(all.length, 1);
  await close(db);
});

test('approveCandidate throws on missing candidate', async () => {
  const db = await fresh();
  await assert.rejects(
    () => approveCandidate(db, 'rule_candidates:does_not_exist'),
    /candidate not found/,
  );
  await close(db);
});
