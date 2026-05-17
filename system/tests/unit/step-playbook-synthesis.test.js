// step-playbook-synthesis.test.js — unit tests for dreamStepPlaybookSynthesis.
//
// Tests:
//  1.  Flag-off path unchanged.
//  2.  Eligible task_type with drift > 0.10 and n=3 → playbook written, version=1,
//      cold_start=true (if no prior).
//  3.  Same task_type runs twice with same evidence (drift=0) → second run skipped.
//  4.  K=5 cap respected (seed 10 eligible types, only 5 processed).
//  5.  Drift × n ranking exercised.
//  6.  Output overflow: LLM returns >cap body → one retry → if still overflow, hard truncate.
//  7.  Cold-start transition: existing cold_start playbook with n=5 graded outcomes
//      since synthesis AND ≥3 days old → flip to cold_start: false.
//  8.  Rule citation: active rule with relates_to_task_types in meta → included.
//  9.  cited_by backpointer written on cited rules.
// 10.  Active playbook → superseded_by + active=false on supersession.
//
// All tests use mem:// DB + runMigrations.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { dreamStepPlaybookSynthesis } from '../../cognition/dream/step-playbook-synthesis.js';
import {
  computeNormalizedDrift,
  estimateTokens,
  parsePlaybookOutput,
  validateFrontmatter,
} from '../../cognition/dream/playbook-synthesis-prompt.js';

// ── Test home setup ──────────────────────────────────────────────────────────
const HOME = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../data/db/migrations');

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, MIGRATIONS_DIR);
  await db.query(`UPSERT runtime:\`self-improvement-v2\` SET value.enabled = true`).collect();
  return db;
}

async function freshDisabled() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, MIGRATIONS_DIR);
  // v2 flag stays false (default)
  return db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed a graded task_outcome memo.
 *
 * @param {object} db
 * @param {string} taskType
 * @param {number} score - 0..1
 * @param {Date} [derivedAt]
 * @returns {Promise<object>} created memo row
 */
/**
 * Seed a graded task_outcome memo.
 * `derived_at` is READONLY in the schema (DEFAULT time::now()), so we cannot
 * set it explicitly. We rely on insertion order for time-ordering tests.
 *
 * @param {object} db
 * @param {string} taskType
 * @param {number} score - 0..1
 * @returns {Promise<object>} created memo row
 */
async function seedGradedOutcome(db, taskType, score) {
  const [rows] = await db
    .query(
      surql`CREATE memos CONTENT ${{
        kind: 'task_outcome',
        content: `task_outcome for ${taskType}: score ${score}`,
        content_hash: `ch-${Math.random().toString(36).slice(2)}`,
        derived_by: 'introspection',
        scope: 'global',
        tags: [],
        meta: {
          task_type: taskType,
          task_id: `task-${Math.random().toString(36).slice(2)}`,
          signals: { self_grade: { completeness: null, correction_likelihood: score } },
          score,
        },
      }}`,
    )
    .collect();
  return Array.isArray(rows) ? rows[0] : rows;
}

/**
 * Build a minimal valid playbook content string.
 */
function buildMinimalPlaybookContent(taskType, version = 1, coldStart = true) {
  return [
    '---',
    `task_type: ${taskType}`,
    `version: ${version}`,
    `active: true`,
    `cold_start: ${coldStart}`,
    `trust: trusted`,
    `signal_count: 3`,
    `declared_sections: [intro]`,
    `length_cap_tokens: 800`,
    `last_synthesized_at: ${new Date().toISOString()}`,
    `evidence_outcomes: []`,
    `related_rules: []`,
    '---',
    '## intro',
    'Some guidance here.',
  ].join('\n');
}

/**
 * Seed an existing active playbook for a task_type.
 */
async function seedActivePlaybook(db, taskType, version = 1, coldStart = false, lastSynthesizedAt = new Date()) {
  const content = buildMinimalPlaybookContent(taskType, version, coldStart);
  const [rows] = await db
    .query(
      surql`CREATE memos CONTENT ${{
        kind: 'playbook',
        content,
        content_hash: `pb-${Math.random().toString(36).slice(2)}`,
        derived_by: 'dream:playbook-synthesis',
        scope: 'global',
        tags: ['playbook', taskType],
        meta: {
          task_type: taskType,
          version,
          active: true,
          cold_start: coldStart,
          trust: 'trusted',
          signal_count: 3,
          length_cap_tokens: 800,
          last_synthesized_at: lastSynthesizedAt.toISOString(),
          evidence_outcomes: [],
          related_rules: [],
          declared_sections: ['intro'],
        },
      }}`,
    )
    .collect();
  return Array.isArray(rows) ? rows[0] : rows;
}

/**
 * Build a fake LLM host that always returns a valid playbook response.
 */
function fakeHost(bodyOverride = null) {
  const body = bodyOverride ?? '## intro\nSome guidance here for the task.';
  return {
    invokeLLM: async (_messages, _opts) => ({
      content: [
        '---',
        'task_type: job:test',
        'version: 1',
        'active: true',
        'cold_start: true',
        'trust: trusted',
        'signal_count: 3',
        'declared_sections: [intro]',
        'length_cap_tokens: 800',
        `last_synthesized_at: ${new Date().toISOString()}`,
        'evidence_outcomes: []',
        'related_rules: []',
        '---',
        body,
      ].join('\n'),
      usage: { input_tokens: 200, output_tokens: 100 },
    }),
  };
}

/**
 * Count playbook memos in DB.
 */
async function countPlaybooks(db) {
  const [rows] = await db
    .query(`SELECT count() FROM memos WHERE kind = 'playbook' GROUP ALL`)
    .collect();
  const r = Array.isArray(rows) ? rows[0] : rows;
  return typeof r?.count === 'number' ? r.count : 0;
}

/**
 * Fetch active playbook for task_type.
 */
async function fetchActivePlaybook(db, taskType) {
  const [rows] = await db
    .query(
      surql`SELECT * FROM memos
            WHERE kind = 'playbook'
              AND meta.task_type = ${taskType}
              AND meta.active = true
            LIMIT 1`,
    )
    .collect();
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

// ── Test 1: flag-off path ────────────────────────────────────────────────────

test('flag off → returns skipped v2_not_enabled', async () => {
  const db = await freshDisabled();
  const r = await dreamStepPlaybookSynthesis(db, null, {});
  assert.deepEqual(r, { skipped: true, reason: 'v2_not_enabled', step: 'playbookSynthesis' });
  await close(db);
});

// ── Test 2: eligible task_type → playbook written ───────────────────────────

test('eligible task_type (drift>0.10, n=3, no prior) → playbook written, version=1, cold_start=true', async () => {
  const db = await fresh();
  const tt = 'job:daily-briefing';

  // Seed 3 graded outcomes with varying scores to produce drift > 0.10
  // Insert sequentially; derived_at is auto-set by DB.
  await seedGradedOutcome(db, tt, 0.2);
  await seedGradedOutcome(db, tt, 0.8);
  await seedGradedOutcome(db, tt, 0.3);

  const r = await dreamStepPlaybookSynthesis(db, fakeHost(), { k: 5 });

  assert.equal(r.skipped, false);
  assert.equal(r.ok, true);
  assert.equal(r.synthesized, 1, 'should have synthesized 1 playbook');
  assert.equal(r.errors, 0);
  assert.equal(r.step, 'playbookSynthesis');

  const pb = await fetchActivePlaybook(db, tt);
  assert.ok(pb, 'active playbook should exist');
  assert.equal(pb.meta.version, 1, 'version should be 1');
  assert.equal(pb.meta.cold_start, true, 'cold_start should be true (n<5)');
  assert.equal(pb.meta.active, true);
  assert.equal(pb.meta.task_type, tt);
  assert.ok(typeof pb.content === 'string' && pb.content.length > 0, 'content should be non-empty');

  await close(db);
});

// ── Test 3: same evidence twice → second run skipped ────────────────────────

test('same evidence (drift=0) with fresh active playbook → second run not eligible', async () => {
  const db = await fresh();
  const tt = 'job:health-trends';

  // Seed 5 outcomes with identical scores → drift = 0
  for (let i = 0; i < 5; i++) {
    await seedGradedOutcome(db, tt, 0.5);
  }

  // First synthesis
  const r1 = await dreamStepPlaybookSynthesis(db, fakeHost(), { k: 5 });
  assert.equal(r1.synthesized, 1, 'first run should synthesize');

  // Seed an active playbook with last_synthesized_at = now (fresh, within 14 days)
  // (the synthesis would have created one, but also do explicit check)
  const pb1 = await fetchActivePlaybook(db, tt);
  assert.ok(pb1, 'active playbook should exist after first run');

  // Second synthesis with same outcomes (no new outcomes → drift still 0)
  const r2 = await dreamStepPlaybookSynthesis(db, fakeHost(), { k: 5 });
  // drift=0 < threshold AND playbook < 14 days → not eligible
  assert.equal(r2.synthesized, 0, 'second run should not synthesize (drift=0, fresh playbook)');

  await close(db);
});

// ── Test 4: K cap respected ─────────────────────────────────────────────────

test('K=5 cap: 10 eligible task_types → only 5 synthesized', async () => {
  const db = await fresh();

  // Seed 10 different task_types with drift > 0.10 and n=3 each
  const taskTypes = [
    'job:daily-briefing',
    'job:health-trends',
    'recall:default',
    'recall:person',
    'turn:analyze',
    'turn:plan',
    'turn:recommend',
    'turn:execute_change',
    'outbound:discord_send:send_dm',
    'outbound:github_write:create-issue',
  ];

  for (const tt of taskTypes) {
    for (let i = 0; i < 3; i++) {
      // Alternating high/low scores to produce drift
      const score = i % 2 === 0 ? 0.9 : 0.1;
      await seedGradedOutcome(db, tt, score);
    }
  }

  const r = await dreamStepPlaybookSynthesis(db, fakeHost(), { k: 5 });

  assert.equal(r.synthesized, 5, 'exactly 5 task_types should be synthesized (K cap)');
  assert.equal(r.selected_count, 5, 'selected_count should be 5');
  assert.ok(r.eligible_count >= 5, 'eligible_count should be >= 5');
  assert.equal(r.errors, 0);

  await close(db);
});

// ── Test 5: drift × n ranking ───────────────────────────────────────────────

test('drift × n ranking: high-drift × high-n task_type synthesized first', async () => {
  const db = await fresh();

  // task_type A: drift ~0.7 × n=4 = 2.8
  const ttA = 'job:daily-briefing';
  for (let i = 0; i < 4; i++) {
    const score = i % 2 === 0 ? 0.9 : 0.1;
    await seedGradedOutcome(db, ttA, score);
  }

  // task_type B: drift ~0.2 × n=3 = 0.6 (lower rank)
  const ttB = 'turn:analyze';
  for (let i = 0; i < 3; i++) {
    const score = 0.5 + (i % 2 === 0 ? 0.15 : -0.15);
    await seedGradedOutcome(db, ttB, score);
  }

  // Only process K=1 to force ranking
  const r = await dreamStepPlaybookSynthesis(db, fakeHost(), { k: 1 });

  assert.equal(r.synthesized, 1);
  // The one synthesized playbook should be for ttA (higher rank)
  const pbA = await fetchActivePlaybook(db, ttA);
  const pbB = await fetchActivePlaybook(db, ttB);
  assert.ok(pbA !== null, 'ttA (higher drift×n) should be synthesized');
  assert.equal(pbB, null, 'ttB (lower rank) should not be synthesized with K=1');

  await close(db);
});

// ── Test 6: output overflow → one retry → hard truncate ─────────────────────

test('overflow: LLM returns body exceeding cap → one retry → hard truncate + overflow flagged', async () => {
  const db = await fresh();
  const tt = 'outbound:discord_send:send_dm';

  // Seed 3 graded outcomes with high drift
  for (let i = 0; i < 3; i++) {
    const score = i % 2 === 0 ? 0.9 : 0.1;
    await seedGradedOutcome(db, tt, score);
  }

  // Build a body that exceeds the token cap for outbound: (400 tokens = ~1600 chars)
  // We'll make the body 2000+ chars to trigger overflow
  const overflowBody = 'X'.repeat(2000); // >>400 token cap for outbound:
  let callCount = 0;

  const overflowHost = {
    invokeLLM: async (_messages, _opts) => {
      callCount++;
      // Both initial and retry return oversized body
      return {
        content: [
          '---',
          `task_type: ${tt}`,
          'version: 1',
          'active: true',
          'cold_start: true',
          'trust: trusted',
          'signal_count: 3',
          'declared_sections: [intro]',
          'length_cap_tokens: 400',
          `last_synthesized_at: ${new Date().toISOString()}`,
          'evidence_outcomes: []',
          'related_rules: []',
          '---',
          overflowBody,
        ].join('\n'),
        usage: { input_tokens: 100, output_tokens: 600 },
      };
    },
  };

  const r = await dreamStepPlaybookSynthesis(db, overflowHost, { k: 5 });

  assert.equal(r.synthesized, 1, 'should still synthesize (hard truncate path)');
  assert.equal(r.overflows, 1, 'overflow count should be 1');
  assert.equal(callCount, 2, 'LLM should be called twice (initial + retry)');

  // Verify the saved playbook body is truncated to cap
  const pb = await fetchActivePlaybook(db, tt);
  assert.ok(pb, 'active playbook should exist');
  // Token cap for outbound: is 400 tokens = ~1600 chars; truncated body should be <= 1600 chars
  const capForOutbound = 400;
  const bodyStart = pb.content.indexOf('---\n', pb.content.indexOf('---') + 3);
  const body = bodyStart >= 0 ? pb.content.slice(bodyStart + 4) : pb.content;
  // The body token count should be at or below the cap
  assert.ok(estimateTokens(body) <= capForOutbound + 10, // +10 for frontmatter delimiter tolerance
    `body should be truncated to ~${capForOutbound} tokens, got ~${estimateTokens(body)}`);

  await close(db);
});

// ── Test 7: cold-start transition ───────────────────────────────────────────

test('cold-start transition: cold_start playbook ≥3 days old + n≥5 outcomes since → flipped to cold_start=false', async () => {
  const db = await fresh();
  const tt = 'job:daily-briefing';

  // Seed an existing cold_start playbook that is more than 3 days old
  const oldDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000); // 4 days ago
  const existingPb = await seedActivePlaybook(db, tt, 1, true, oldDate);

  // Seed 5 graded outcomes; since derived_at defaults to now() and oldDate is 4
  // days ago, all seeded outcomes will be "after" the cold_start synthesis.
  for (let i = 0; i < 5; i++) {
    await seedGradedOutcome(db, tt, 0.5 + i * 0.05);
  }

  // Run with a host that produces constant-score responses (drift near 0 but fresh playbook check passes
  // because the playbook is OLD — > 14 days? No, oldDate is 4 days. Drift=0 + fresh (4d < 14d) → still skips synthesis.
  // But cold-start transition runs independently of synthesis eligibility.
  const r = await dreamStepPlaybookSynthesis(db, fakeHost(), { k: 5 });

  // The cold-start transition should flip the playbook
  // (Fetch by id since active may have changed)
  const [rows] = await db
    .query(surql`SELECT * FROM memos WHERE id = ${existingPb.id} LIMIT 1`)
    .collect();
  const updatedPb = Array.isArray(rows) ? (rows[0] ?? null) : null;

  assert.ok(updatedPb, 'playbook should still exist');
  assert.equal(
    updatedPb.meta.cold_start,
    false,
    'cold_start should be flipped to false (n≥5 AND ≥3 days old)',
  );

  await close(db);
});

// ── Test 8: rule citation ────────────────────────────────────────────────────

test('rule citation: active rule with meta.relates_to_task_types includes task_type → included in prompt', async () => {
  const db = await fresh();
  const tt = 'turn:analyze';

  // Seed graded outcomes
  for (let i = 0; i < 3; i++) {
    const score = i % 2 === 0 ? 0.9 : 0.1;
    await seedGradedOutcome(db, tt, score);
  }

  // Seed an active rule that relates to this task_type (via meta.relates_to_task_types)
  const [ruleRows] = await db
    .query(
      surql`CREATE rules CONTENT ${{
        content: 'Always provide a structured analysis with pros and cons.',
        kind: 'behavior',
        active: true,
        priority: 50,
        meta: {
          relates_to_task_types: [tt, 'turn:plan'],
          cited_by: [],
        },
      }}`,
    )
    .collect();
  const rule = Array.isArray(ruleRows) ? ruleRows[0] : ruleRows;
  assert.ok(rule?.id, 'rule should be created');

  // Track what prompts were sent to LLM
  const capturedPrompts = [];
  const trackingHost = {
    invokeLLM: async (messages, _opts) => {
      const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
      capturedPrompts.push(userMsg);
      return fakeHost().invokeLLM(messages, _opts);
    },
  };

  const r = await dreamStepPlaybookSynthesis(db, trackingHost, { k: 5 });

  assert.equal(r.synthesized, 1);
  assert.ok(capturedPrompts.length >= 1, 'LLM should have been called');

  // The rule's id should appear in the synthesis prompt
  const ruleIdStr = String(rule.id);
  const prompt = capturedPrompts[0];
  assert.ok(
    prompt.includes(ruleIdStr),
    `synthesis prompt should include rule id ${ruleIdStr}`,
  );

  await close(db);
});

// ── Test 9: cited_by backpointer ─────────────────────────────────────────────

test('cited_by backpointer: synthesized playbook → backpointer written on cited rule', async () => {
  const db = await fresh();
  const tt = 'turn:recommend';

  // Seed graded outcomes
  for (let i = 0; i < 3; i++) {
    const score = i % 2 === 0 ? 0.9 : 0.1;
    await seedGradedOutcome(db, tt, score);
  }

  // Seed a related rule
  const [ruleRows] = await db
    .query(
      surql`CREATE rules CONTENT ${{
        content: 'Recommend products with purchase links.',
        kind: 'behavior',
        active: true,
        priority: 50,
        meta: {
          relates_to_task_types: [tt],
          cited_by: [],
        },
      }}`,
    )
    .collect();
  const rule = Array.isArray(ruleRows) ? ruleRows[0] : ruleRows;

  await dreamStepPlaybookSynthesis(db, fakeHost(), { k: 5 });

  // Check cited_by backpointer
  const [rows] = await db
    .query(surql`SELECT meta FROM rules WHERE id = ${rule.id} LIMIT 1`)
    .collect();
  const updatedRule = Array.isArray(rows) ? (rows[0] ?? null) : null;
  assert.ok(updatedRule, 'rule should exist');

  const citedBy = updatedRule?.meta?.cited_by ?? [];
  assert.ok(Array.isArray(citedBy), 'cited_by should be an array');
  assert.ok(citedBy.length > 0, 'cited_by should have at least one entry');

  // The entry should be a string referencing the new playbook
  const pb = await fetchActivePlaybook(db, tt);
  assert.ok(pb, 'playbook should exist');
  const pbIdStr = String(pb.id);
  assert.ok(
    citedBy.some((entry) => String(entry) === pbIdStr),
    `cited_by should include new playbook id ${pbIdStr}, got: ${JSON.stringify(citedBy)}`,
  );

  await close(db);
});

// ── Test 10: active playbook supersession ────────────────────────────────────

test('active playbook → superseded: prior active=false + superseded_by set, new version=prior+1', async () => {
  const db = await fresh();
  const tt = 'turn:plan';

  // Seed an existing active playbook at version 3
  const prior = await seedActivePlaybook(db, tt, 3, false, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));

  // Seed graded outcomes with high drift to trigger synthesis
  for (let i = 0; i < 4; i++) {
    const score = i % 2 === 0 ? 0.9 : 0.1;
    await seedGradedOutcome(db, tt, score);
  }

  const r = await dreamStepPlaybookSynthesis(db, fakeHost(), { k: 5 });

  assert.equal(r.synthesized, 1, 'should synthesize 1 playbook');

  // Check prior playbook is now inactive + has superseded_by set
  const [priorRows] = await db
    .query(surql`SELECT * FROM memos WHERE id = ${prior.id} LIMIT 1`)
    .collect();
  const updatedPrior = Array.isArray(priorRows) ? (priorRows[0] ?? null) : null;
  assert.ok(updatedPrior, 'prior playbook should still exist');
  assert.equal(updatedPrior.meta.active, false, 'prior playbook should be inactive');
  assert.ok(
    updatedPrior.meta.superseded_by,
    'prior playbook should have superseded_by set',
  );

  // New active playbook should be at version 4
  const newPb = await fetchActivePlaybook(db, tt);
  assert.ok(newPb, 'new active playbook should exist');
  assert.equal(newPb.meta.version, 4, 'new playbook version should be prior + 1');
  assert.equal(newPb.meta.active, true);

  // superseded_by should match new playbook's id
  assert.equal(
    String(updatedPrior.meta.superseded_by),
    String(newPb.id),
    'superseded_by should point to the new playbook',
  );

  await close(db);
});

// ── Unit tests for helper functions ──────────────────────────────────────────

test('computeNormalizedDrift: <2 scored rows → 0', () => {
  assert.equal(computeNormalizedDrift([]), 0);
  assert.equal(computeNormalizedDrift([{ meta: { score: 0.5 } }]), 0);
  assert.equal(computeNormalizedDrift([{ meta: { score: null } }, { meta: { score: null } }]), 0);
});

test('computeNormalizedDrift: 2 rows with scores → correct normalization', () => {
  // |0.9 - 0.1| = 0.8; n=2; norm factor = 2/(2+5) = 2/7 ≈ 0.2857
  const drift = computeNormalizedDrift([
    { meta: { score: 0.1 }, derived_at: new Date().toISOString() },
    { meta: { score: 0.9 }, derived_at: new Date().toISOString() },
  ]);
  const expected = 0.8 * (2 / 7);
  assert.ok(
    Math.abs(drift - expected) < 0.0001,
    `expected drift ≈ ${expected.toFixed(4)}, got ${drift.toFixed(4)}`,
  );
});

test('computeNormalizedDrift: 3 same-score rows → drift = 0', () => {
  const rows = [0.5, 0.5, 0.5].map((s) => ({ meta: { score: s } }));
  assert.equal(computeNormalizedDrift(rows), 0);
});

test('parsePlaybookOutput: valid frontmatter + body → correct parse', () => {
  const text = [
    '---',
    'task_type: job:test',
    'version: 2',
    'active: true',
    'cold_start: false',
    'trust: trusted',
    'signal_count: 10',
    'declared_sections: [intro, steps, tips]',
    'length_cap_tokens: 800',
    'last_synthesized_at: 2026-01-01T00:00:00Z',
    'evidence_outcomes: []',
    'related_rules: []',
    '---',
    '## intro',
    'Hello world.',
  ].join('\n');

  const { frontmatter, body } = parsePlaybookOutput(text);
  assert.ok(frontmatter, 'frontmatter should parse');
  assert.equal(frontmatter.task_type, 'job:test');
  assert.equal(frontmatter.version, 2);
  assert.equal(frontmatter.active, true);
  assert.equal(frontmatter.cold_start, false);
  assert.deepEqual(frontmatter.declared_sections, ['intro', 'steps', 'tips']);
  assert.ok(body.includes('## intro'));
});

test('parsePlaybookOutput: no frontmatter → null frontmatter, raw body', () => {
  const { frontmatter, body } = parsePlaybookOutput('just some text');
  assert.equal(frontmatter, null);
  assert.equal(body, 'just some text');
});

test('validateFrontmatter: all required fields present → ok', () => {
  const result = validateFrontmatter({
    task_type: 'job:test',
    version: 1,
    active: true,
    cold_start: false,
    signal_count: 3,
    declared_sections: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('validateFrontmatter: missing fields → not ok', () => {
  const result = validateFrontmatter({ task_type: 'job:test' });
  assert.equal(result.ok, false);
  assert.ok(result.missing.length > 0);
  assert.ok(result.missing.includes('version'));
});
