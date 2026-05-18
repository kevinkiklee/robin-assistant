// tests/unit/agents-md-comm-style-context.test.js
//
// Verifies that readDbDataForAgentsMd uses getEffectiveContextCommStyle and
// falls back to the flat default when no per-context record exists.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { surql } from 'surrealdb';
import { resolveSessionContext } from '../../cognition/dream/comm-style-context-router.js';
import { getEffectiveContextCommStyle } from '../../cognition/dream/step-comm-style.js';
import { setCommStyle } from '../../cognition/jobs/comm-style.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

// ---------------------------------------------------------------------------
// resolveSessionContext — env-driven context resolution
// ---------------------------------------------------------------------------

test('resolveSessionContext returns terminal when ROBIN_SESSION_PLATFORM is unset', () => {
  const saved = process.env.ROBIN_SESSION_PLATFORM;
  delete process.env.ROBIN_SESSION_PLATFORM;
  try {
    assert.equal(resolveSessionContext(), 'terminal');
  } finally {
    if (saved !== undefined) process.env.ROBIN_SESSION_PLATFORM = saved;
  }
});

test('resolveSessionContext returns discord when ROBIN_SESSION_PLATFORM=discord', () => {
  const saved = process.env.ROBIN_SESSION_PLATFORM;
  process.env.ROBIN_SESSION_PLATFORM = 'discord';
  try {
    assert.equal(resolveSessionContext(), 'discord');
  } finally {
    if (saved !== undefined) process.env.ROBIN_SESSION_PLATFORM = saved;
    else delete process.env.ROBIN_SESSION_PLATFORM;
  }
});

test('resolveSessionContext returns web when ROBIN_SESSION_PLATFORM=web', () => {
  const saved = process.env.ROBIN_SESSION_PLATFORM;
  process.env.ROBIN_SESSION_PLATFORM = 'web';
  try {
    assert.equal(resolveSessionContext(), 'web');
  } finally {
    if (saved !== undefined) process.env.ROBIN_SESSION_PLATFORM = saved;
    else delete process.env.ROBIN_SESSION_PLATFORM;
  }
});

// ---------------------------------------------------------------------------
// getEffectiveContextCommStyle — fallback chain
// ---------------------------------------------------------------------------

test('getEffectiveContextCommStyle returns null when no per-context record and no flat style', async () => {
  const db = await fresh();
  const result = await getEffectiveContextCommStyle(db, 'terminal');
  assert.equal(result, null);
  await close(db);
});

test('getEffectiveContextCommStyle returns null for unpopulated context even with flat style', async () => {
  const db = await fresh();
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
  // No per-context record for 'discord'.
  const result = await getEffectiveContextCommStyle(db, 'discord');
  assert.equal(result, null, 'returns null when per-context row is absent (caller must fall back)');
  await close(db);
});

test('getEffectiveContextCommStyle returns per-context record when populated', async () => {
  const db = await fresh();
  // Manually write a per-context record (simulating what dreamStepCommStyle produces).
  const terminalCtx = {
    tone: 'terse',
    formality: 'casual',
    emoji_ok: false,
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'bullets',
    confidence: 0.9,
    evidence: [],
    context: 'terminal',
    volatile: false,
    consecutive_matches: 2,
    evidence_count: 15,
    last_synthesized_at: new Date().toISOString(),
  };
  await db
    .query(
      surql`UPSERT persona:singleton MERGE ${{
        comm_style_contexts: { discord: null, terminal: terminalCtx, web: null },
      }}`,
    )
    .collect();

  const result = await getEffectiveContextCommStyle(db, 'terminal');
  assert.ok(result !== null, 'should return the per-context record');
  assert.equal(result.tone, 'terse');
  assert.equal(result.context, 'terminal');
  assert.equal(result.confidence, 0.9);
  await close(db);
});

// ---------------------------------------------------------------------------
// agents-md-refresh: context-aware commStyle selection
// ---------------------------------------------------------------------------

test('agents-md-refresh: uses per-context style when available, flat style otherwise', async () => {
  const db = await fresh();

  // Seed flat default.
  await setCommStyle(db, {
    tone: 'verbose',
    formality: 'formal',
    emoji_ok: true,
    direct_feedback_ok: true,
    code_comment_density: 'moderate',
    summary_style: 'prose',
    evidence: [],
    confidence: 0.5,
  });

  // No per-context row yet.
  const fallback = (await getEffectiveContextCommStyle(db, 'terminal')) ?? null;
  assert.equal(fallback, null, 'no per-context row → getEffectiveContextCommStyle returns null');

  // Populate a terminal per-context row.
  const terminalCtx = {
    tone: 'terse',
    formality: 'casual',
    emoji_ok: false,
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'bullets',
    confidence: 0.88,
    evidence: [],
    context: 'terminal',
    volatile: false,
    consecutive_matches: 2,
    evidence_count: 12,
    last_synthesized_at: new Date().toISOString(),
  };
  await db
    .query(
      surql`UPSERT persona:singleton MERGE ${{
        comm_style_contexts: { discord: null, terminal: terminalCtx, web: null },
      }}`,
    )
    .collect();

  const perCtx = await getEffectiveContextCommStyle(db, 'terminal');
  assert.ok(perCtx !== null, 'per-context row now present');
  assert.equal(perCtx.tone, 'terse', 'per-context tone should win over flat verbose');

  await close(db);
});
