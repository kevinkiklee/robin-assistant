// tests/unit/comm-style-per-context.test.js
//
// Tests for per-context comm-style synthesis (spec §4d).
// Covers: context routing, per-context synthesis, convergence, <10-event fallback,
// and backward-compat with existing flat comm_style shape.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import {
  dreamStepCommStyle,
  getEffectiveContextCommStyle,
} from '../../cognition/dream/step-comm-style.js';
import {
  inferEventContext,
  partitionByContext,
} from '../../cognition/dream/comm-style-context-router.js';
import { getCommStyle, setCommStyle } from '../../cognition/jobs/comm-style.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function seedCorrection(db, content, meta = {}) {
  const [rows] = await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'manual',
        content,
        content_hash: `h-${Math.random().toString(36).slice(2)}`,
        meta: { kind: 'correction', ...meta },
      }}`,
    )
    .collect();
  return rows[0].id;
}

const validShape = (overrides = {}) => ({
  tone: 'terse',
  formality: 'casual',
  emoji_ok: false,
  direct_feedback_ok: true,
  code_comment_density: 'minimal',
  summary_style: 'bullets',
  confidence: 0.8,
  evidence_indices: [],
  ...overrides,
});

function stubLLM(output) {
  return { invokeLLM: async () => ({ content: output }) };
}

function countingStubLLM(output) {
  let calls = 0;
  const host = {
    invokeLLM: async () => {
      calls++;
      return { content: output, usage: { input_tokens: 5, output_tokens: 5 } };
    },
    get calls() {
      return calls;
    },
  };
  return host;
}

async function readContextsRaw(db) {
  const [rows] = await db.query(surql`SELECT comm_style_contexts FROM persona:singleton`).collect();
  return rows?.[0]?.comm_style_contexts ?? null;
}

// ---------------------------------------------------------------------------
// Unit: context routing
// ---------------------------------------------------------------------------

test('inferEventContext — discord meta.platform → discord', () => {
  assert.equal(inferEventContext({ meta: { platform: 'discord' } }), 'discord');
});

test('inferEventContext — discord meta.channel → discord', () => {
  assert.equal(inferEventContext({ meta: { channel: 'discord' } }), 'discord');
});

test('inferEventContext — web meta.platform → web', () => {
  assert.equal(inferEventContext({ meta: { platform: 'web' } }), 'web');
});

test('inferEventContext — askrobin in session_source → web', () => {
  assert.equal(inferEventContext({ meta: { session_source: 'https://askrobin.io/chat' } }), 'web');
});

test('inferEventContext — no meta → terminal', () => {
  assert.equal(inferEventContext({ meta: {} }), 'terminal');
  assert.equal(inferEventContext({}), 'terminal');
  assert.equal(inferEventContext({ meta: { kind: 'correction' } }), 'terminal');
});

test('partitionByContext splits events by context', () => {
  const events = [
    { id: '1', meta: { platform: 'discord' } },
    { id: '2', meta: { platform: 'web' } },
    { id: '3', meta: {} },
    { id: '4', meta: { channel: 'discord' } },
  ];
  const buckets = partitionByContext(events);
  assert.equal(buckets.discord.length, 2);
  assert.equal(buckets.web.length, 1);
  assert.equal(buckets.terminal.length, 1);
});

// ---------------------------------------------------------------------------
// Integration: per-context synthesis persists correctly
// ---------------------------------------------------------------------------

test('per-context: context with <10 events stays null in comm_style_contexts', async () => {
  const db = await fresh();
  // Seed 5 discord corrections (below the 10-event threshold).
  for (let i = 0; i < 5; i++) {
    await seedCorrection(db, `discord correction ${i}`, { platform: 'discord' });
  }
  const llm = stubLLM(JSON.stringify(validShape()));
  const result = await dreamStepCommStyle(db, llm);
  assert.equal(result.ok, true);

  const ctxs = await readContextsRaw(db);
  // contexts object was initialized but discord stays null (< 10 events).
  assert.ok(ctxs !== null, 'comm_style_contexts should be written');
  assert.equal(ctxs.discord, null, 'discord < 10 events → null');
  await close(db);
});

test('per-context: discord-tagged events ≥10 → discord context populated', async () => {
  const db = await fresh();
  for (let i = 0; i < 12; i++) {
    await seedCorrection(db, `discord correction ${i}: be concise`, {
      platform: 'discord',
    });
  }
  const llm = stubLLM(JSON.stringify(validShape({ tone: 'terse', confidence: 0.75 })));
  await dreamStepCommStyle(db, llm);

  const ctxs = await readContextsRaw(db);
  assert.ok(ctxs?.discord !== null, 'discord ≥10 events → record should exist');
  assert.equal(ctxs.discord.tone, 'terse');
  assert.equal(ctxs.discord.confidence, 0.75);
  assert.equal(ctxs.discord.context, 'discord');
  assert.equal(ctxs.discord.evidence_count, 12);
  await close(db);
});

test('per-context: only discord-tagged events trigger discord synthesis; terminal stays null', async () => {
  const db = await fresh();
  // 12 discord events, 0 terminal events.
  for (let i = 0; i < 12; i++) {
    await seedCorrection(db, `discord msg ${i}`, { platform: 'discord' });
  }
  const llm = stubLLM(JSON.stringify(validShape()));
  await dreamStepCommStyle(db, llm);
  const ctxs = await readContextsRaw(db);
  assert.ok(ctxs.discord !== null, 'discord should be populated');
  assert.equal(ctxs.terminal, null, 'terminal had 0 events → null');
  assert.equal(ctxs.web, null, 'web had 0 events → null');
  await close(db);
});

test('per-context: existing flat comm_style row still works after per-context step runs', async () => {
  const db = await fresh();
  // Pre-seed the flat (default) comm_style shape, simulating existing data.
  await setCommStyle(db, {
    tone: 'verbose',
    formality: 'formal',
    emoji_ok: true,
    direct_feedback_ok: true,
    code_comment_density: 'moderate',
    summary_style: 'prose',
    evidence: [],
    confidence: 0.6,
  });
  // Add enough corrections for default synthesis path (≥3) but <10 for any context.
  for (let i = 0; i < 4; i++) {
    await seedCorrection(db, `generic correction ${i}`);
  }
  const llm = stubLLM(
    JSON.stringify(
      validShape({ tone: 'terse', formality: 'casual', summary_style: 'bullets', confidence: 0.9 }),
    ),
  );
  await dreamStepCommStyle(db, llm);
  // Existing consumers read comm_style (flat default) — should still be valid.
  const flat = await getCommStyle(db);
  assert.ok(flat, 'flat comm_style should still exist after per-context step');
  assert.ok(typeof flat.tone === 'string', 'flat.tone should be a string');
  await close(db);
});

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

test('convergence: 2 consecutive synthesizes with identical evidence → volatile=false', async () => {
  const db = await fresh();
  for (let i = 0; i < 12; i++) {
    await seedCorrection(db, `discord convergence ${i}`, { platform: 'discord' });
  }
  const llm = stubLLM(JSON.stringify(validShape({ tone: 'terse', confidence: 0.8 })));

  // First run: volatile should be true (only 1 consecutive match).
  await dreamStepCommStyle(db, llm);
  const ctxs1 = await readContextsRaw(db);
  assert.equal(ctxs1.discord.volatile, true, 'first run: volatile=true');
  assert.equal(ctxs1.discord.consecutive_matches, 1);

  // Second run: same evidence, same LLM output — hash matches → volatile=false.
  await dreamStepCommStyle(db, llm);
  const ctxs2 = await readContextsRaw(db);
  assert.equal(ctxs2.discord.volatile, false, 'second run with same evidence: volatile=false');
  assert.ok(ctxs2.discord.consecutive_matches >= 2);
  await close(db);
});

test('convergence: different evidence between synthesizes → volatile=true reset', async () => {
  const db = await fresh();
  for (let i = 0; i < 12; i++) {
    await seedCorrection(db, `discord stable ${i}`, { platform: 'discord' });
  }
  const llm = stubLLM(JSON.stringify(validShape({ tone: 'terse', confidence: 0.8 })));

  // First run → volatile=true.
  await dreamStepCommStyle(db, llm);
  // Second run with same evidence → volatile=false.
  await dreamStepCommStyle(db, llm);
  const ctxs = await readContextsRaw(db);
  assert.equal(ctxs.discord.volatile, false);

  // Now add a new correction — changes the input_hash.
  await seedCorrection(db, 'discord new evidence changes hash', { platform: 'discord' });
  // Third run: different input_hash → new LLM call → consecutive_matches resets → volatile=true.
  await dreamStepCommStyle(db, llm);
  const ctxs3 = await readContextsRaw(db);
  // consecutive_matches should reset because input_hash changed.
  assert.equal(ctxs3.discord.volatile, true, 'new evidence resets convergence → volatile=true');
  await close(db);
});

// ---------------------------------------------------------------------------
// getEffectiveContextCommStyle helper
// ---------------------------------------------------------------------------

test('getEffectiveContextCommStyle returns null when no per-context record', async () => {
  const db = await fresh();
  const result = await getEffectiveContextCommStyle(db, 'discord');
  assert.equal(result, null);
  await close(db);
});

test('getEffectiveContextCommStyle returns populated record for synthesized context', async () => {
  const db = await fresh();
  for (let i = 0; i < 12; i++) {
    await seedCorrection(db, `discord effective test ${i}`, { platform: 'discord' });
  }
  const llm = stubLLM(JSON.stringify(validShape({ tone: 'balanced', confidence: 0.6 })));
  await dreamStepCommStyle(db, llm);

  const eff = await getEffectiveContextCommStyle(db, 'discord');
  assert.ok(eff !== null, 'discord context should have a record');
  assert.equal(eff.context, 'discord');
  assert.equal(typeof eff.tone, 'string');
  await close(db);
});
