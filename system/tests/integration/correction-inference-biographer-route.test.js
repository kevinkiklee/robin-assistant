// Integration test: correction-inference hook in the biographer route.
//
// Verifies:
//  1. When v2 flag is enabled + user turn matches pattern + antecedent qualifies:
//     - events:explicit_correction row written
//     - memos:task_outcome row written with score=0
//  2. When v2 flag is disabled: no rows written (gate-off).
//  3. When pattern does not match: no rows written.
//  4. When antecedent does not qualify: no rows written.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir as __robinTmpdir, tmpdir } from 'node:os';
import { join as __robinJoin, join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { biographerRoutes } from '../../runtime/daemon/routes/biographer.js';
import { setSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-ci-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

const route = biographerRoutes.find(
  (r) => r.method === 'POST' && r.path === '/internal/biographer/process-pending',
);

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

/**
 * Write a transcript JSONL file with an optional prior assistant turn
 * (for antecedent classification), a current user message, and a current
 * assistant response.
 *
 * @param {{
 *   priorAssistantText?: string,
 *   priorAssistantToolNames?: string[],
 *   currentUserText: string,
 *   currentAssistantText?: string,
 * }} options
 * @returns {string} transcript file path
 */
function makeTranscript({
  priorAssistantText = '',
  priorAssistantToolNames = [],
  currentUserText,
  currentAssistantText = 'Understood.',
}) {
  const dir = join(tmpdir(), `robin-ci-t-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.jsonl');

  const lines = [];

  // Prior assistant turn (potential antecedent)
  if (priorAssistantText || priorAssistantToolNames.length > 0) {
    const content = [];
    if (priorAssistantText) {
      content.push({ type: 'text', text: priorAssistantText });
    }
    for (const name of priorAssistantToolNames) {
      content.push({ type: 'tool_use', id: `tool_${name}`, name, input: {} });
    }
    lines.push({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
      },
    });
  }

  // Current user message (potential correction)
  lines.push({
    type: 'user',
    message: { role: 'user', content: currentUserText },
  });

  // Current assistant response (just generated, being processed by Stop hook)
  lines.push({
    type: 'assistant',
    message: { role: 'assistant', content: currentAssistantText },
  });

  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return path;
}

/**
 * Build a minimal fake ctx for the route handler.
 * Provides ctx.db, ctx.embedder.wrap, ctx.host, ctx.accumulator, ctx.queue.
 */
function makeFakeCtx(db) {
  const e = createStubEmbedder({ dimension: 1024 });
  return {
    db,
    embedder: { wrap: e },
    host: { name: 'test-host' },
    accumulator: {
      add: () => {},
      refreshConfig: async () => {},
    },
    queue: { enqueue: () => Promise.resolve() },
  };
}

// ─── Test 1: v2 enabled + correction pattern + strong antecedent → rows written ─

test('v2 enabled: correction + AskUserQuestion antecedent writes explicit_correction + task_outcome', async () => {
  const db = await fresh();
  try {
    await setSelfImprovementV2Enabled(db, true);

    const transcriptPath = makeTranscript({
      priorAssistantText: 'Which option do you prefer?',
      priorAssistantToolNames: ['AskUserQuestion'],
      currentUserText: 'no actually option B',
    });

    const ctx = makeFakeCtx(db);
    await route.handler({ ctx, body: { transcript_path: transcriptPath, session_id: 's1' } });

    // explicit_correction event
    const [corrEvents] = await db
      .query(surql`SELECT * FROM events WHERE source = 'explicit_correction'`)
      .collect();
    assert.equal(corrEvents.length, 1, 'expected one explicit_correction event');
    assert.equal(corrEvents[0].content, 'no actually option B');
    assert.equal(corrEvents[0].meta.session_id, 's1');

    // task_outcome memo
    const [outcomes] = await db
      .query(surql`SELECT * FROM memos WHERE kind = 'task_outcome'`)
      .collect();
    assert.equal(outcomes.length, 1, 'expected one task_outcome memo');
    assert.equal(outcomes[0].meta.score, 0);
    assert.equal(outcomes[0].meta.task_type, 'turn:default');
    assert.ok(outcomes[0].meta.signals?.explicit_correction?.text === 'no actually option B');
  } finally {
    await close(db);
  }
});

// ─── Test 2: v2 flag disabled → nothing written ──────────────────────────────

test('v2 disabled: no explicit_correction or task_outcome written even if correction matches', async () => {
  const db = await fresh();
  try {
    // flag is false by default; don't enable it
    const transcriptPath = makeTranscript({
      priorAssistantToolNames: ['AskUserQuestion'],
      currentUserText: 'no wrong',
    });

    const ctx = makeFakeCtx(db);
    await route.handler({ ctx, body: { transcript_path: transcriptPath } });

    const [corrEvents] = await db
      .query(surql`SELECT * FROM events WHERE source = 'explicit_correction'`)
      .collect();
    assert.equal(corrEvents.length, 0, 'expected no explicit_correction with v2 disabled');

    const [outcomes] = await db
      .query(surql`SELECT * FROM memos WHERE kind = 'task_outcome'`)
      .collect();
    assert.equal(outcomes.length, 0, 'expected no task_outcome with v2 disabled');
  } finally {
    await close(db);
  }
});

// ─── Test 3: v2 enabled + pattern does not match → nothing written ────────────

test('v2 enabled: no correction written when pattern does not match', async () => {
  const db = await fresh();
  try {
    await setSelfImprovementV2Enabled(db, true);

    const transcriptPath = makeTranscript({
      priorAssistantToolNames: ['AskUserQuestion'],
      currentUserText: 'sounds great, go ahead',
    });

    const ctx = makeFakeCtx(db);
    await route.handler({ ctx, body: { transcript_path: transcriptPath } });

    const [corrEvents] = await db
      .query(surql`SELECT * FROM events WHERE source = 'explicit_correction'`)
      .collect();
    assert.equal(
      corrEvents.length,
      0,
      'expected no explicit_correction when pattern does not match',
    );
  } finally {
    await close(db);
  }
});

// ─── Test 4: v2 enabled + pattern matches but antecedent unqualified → nothing written ─

test('v2 enabled: no correction written when antecedent does not qualify', async () => {
  const db = await fresh();
  try {
    await setSelfImprovementV2Enabled(db, true);

    const transcriptPath = makeTranscript({
      // No tool calls, no numbered list, no question mark → antecedent unqualified
      priorAssistantText: 'Here is a plain statement.',
      priorAssistantToolNames: [],
      currentUserText: 'no that is wrong',
    });

    const ctx = makeFakeCtx(db);
    await route.handler({ ctx, body: { transcript_path: transcriptPath } });

    const [corrEvents] = await db
      .query(surql`SELECT * FROM events WHERE source = 'explicit_correction'`)
      .collect();
    assert.equal(
      corrEvents.length,
      0,
      'expected no explicit_correction when antecedent unqualified',
    );
  } finally {
    await close(db);
  }
});

// ─── Test 5: v2 enabled + two weak signals qualify ────────────────────────────

test('v2 enabled: correction fires with two weak signals (numbered list + question mark)', async () => {
  const db = await fresh();
  try {
    await setSelfImprovementV2Enabled(db, true);

    const transcriptPath = makeTranscript({
      priorAssistantText: '1. Option A\n2. Option B\nWhich do you prefer?',
      currentUserText: 'actually I wanted option A',
    });

    const ctx = makeFakeCtx(db);
    await route.handler({ ctx, body: { transcript_path: transcriptPath } });

    const [corrEvents] = await db
      .query(surql`SELECT * FROM events WHERE source = 'explicit_correction'`)
      .collect();
    assert.equal(corrEvents.length, 1, 'expected explicit_correction with two weak signals');
    assert.equal(corrEvents[0].content, 'actually I wanted option A');
  } finally {
    await close(db);
  }
});

// ─── Test 6: no transcript_path → nothing written (does not crash) ────────────

test('no transcript_path: route completes without writing correction rows', async () => {
  const db = await fresh();
  try {
    await setSelfImprovementV2Enabled(db, true);
    const ctx = makeFakeCtx(db);
    // No transcript_path in body
    const result = await route.handler({ ctx, body: {} });
    assert.equal(result.enqueued, 0);

    const [corrEvents] = await db
      .query(surql`SELECT * FROM events WHERE source = 'explicit_correction'`)
      .collect();
    assert.equal(corrEvents.length, 0);
  } finally {
    await close(db);
  }
});

// ─── Test 7: predict call = strong antecedent ─────────────────────────────────

test('v2 enabled: predict tool call qualifies as strong antecedent', async () => {
  const db = await fresh();
  try {
    await setSelfImprovementV2Enabled(db, true);

    const transcriptPath = makeTranscript({
      priorAssistantText: 'I predict this will take 3 days.',
      priorAssistantToolNames: ['mcp__robin__predict'],
      currentUserText: 'wrong, it took 1 day',
    });

    const ctx = makeFakeCtx(db);
    await route.handler({ ctx, body: { transcript_path: transcriptPath } });

    const [corrEvents] = await db
      .query(surql`SELECT * FROM events WHERE source = 'explicit_correction'`)
      .collect();
    assert.equal(corrEvents.length, 1, 'expected explicit_correction with predict antecedent');
  } finally {
    await close(db);
  }
});
