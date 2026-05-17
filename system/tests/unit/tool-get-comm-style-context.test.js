// tests/unit/tool-get-comm-style-context.test.js
//
// Verifies the get_comm_style MCP tool's per-context path:
//   - explicit context arg returns that context's data (or falls back to default)
//   - no context arg uses ROBIN_SESSION_PLATFORM env
//   - unsynthesized state returns defaults with synthesized: false

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { createGetCommStyleTool } from '../../io/mcp/tools/get-comm-style.js';
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

function makeDiscordCtxRow(overrides = {}) {
  return {
    tone: 'terse',
    formality: 'casual',
    emoji_ok: false,
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'bullets',
    confidence: 0.82,
    evidence: [],
    context: 'discord',
    volatile: false,
    consecutive_matches: 2,
    evidence_count: 11,
    last_synthesized_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

test('get_comm_style: returns defaults with synthesized=false when nothing persisted', async () => {
  const db = await fresh();
  const tool = createGetCommStyleTool({ db });
  const result = await tool.handler({});
  assert.equal(result.synthesized, false);
  assert.equal(result.confidence, 0);
  assert.equal(result.tone, 'balanced');
  await close(db);
});

test('get_comm_style: returns flat default with synthesized=true when only flat style exists', async () => {
  const db = await fresh();
  await setCommStyle(db, {
    tone: 'verbose',
    formality: 'formal',
    emoji_ok: true,
    direct_feedback_ok: true,
    code_comment_density: 'moderate',
    summary_style: 'prose',
    evidence: [],
    confidence: 0.55,
  });
  const tool = createGetCommStyleTool({ db });
  const result = await tool.handler({});
  assert.equal(result.synthesized, true);
  assert.equal(result.tone, 'verbose');
  await close(db);
});

test('get_comm_style: explicit context=discord returns discord per-context row', async () => {
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
  // Seed per-context discord row.
  await db
    .query(
      surql`UPSERT persona:singleton MERGE ${{
        comm_style_contexts: {
          discord: makeDiscordCtxRow({ tone: 'terse' }),
          terminal: null,
          web: null,
        },
      }}`,
    )
    .collect();

  const tool = createGetCommStyleTool({ db });
  const result = await tool.handler({ context: 'discord' });
  assert.equal(result.synthesized, true);
  assert.equal(result.tone, 'terse', 'discord per-context tone should win');
  assert.equal(result.context, 'discord');
  await close(db);
});

test('get_comm_style: explicit context falls back to flat when per-context row absent', async () => {
  const db = await fresh();
  await setCommStyle(db, {
    tone: 'balanced',
    formality: 'balanced',
    emoji_ok: false,
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'mixed',
    evidence: [],
    confidence: 0.3,
  });
  // No per-context rows.
  const tool = createGetCommStyleTool({ db });
  const result = await tool.handler({ context: 'discord' });
  // No discord per-context → falls back to flat.
  assert.equal(result.synthesized, true);
  assert.equal(result.tone, 'balanced');
  // result.context is not set when coming from the flat path.
  await close(db);
});

test('get_comm_style: invalid context arg is ignored, falls back to env resolution', async () => {
  const db = await fresh();
  await setCommStyle(db, {
    tone: 'terse',
    formality: 'casual',
    emoji_ok: false,
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'bullets',
    evidence: [],
    confidence: 0.7,
  });
  const saved = process.env.ROBIN_SESSION_PLATFORM;
  delete process.env.ROBIN_SESSION_PLATFORM; // → terminal
  try {
    const tool = createGetCommStyleTool({ db });
    // 'foobar' is not a valid context — should fall through to env-based resolution.
    const result = await tool.handler({ context: 'foobar' });
    // No per-context for terminal → falls back to flat.
    assert.equal(result.synthesized, true);
    assert.equal(result.tone, 'terse');
  } finally {
    if (saved !== undefined) process.env.ROBIN_SESSION_PLATFORM = saved;
  }
  await close(db);
});

test('get_comm_style: no context arg picks up ROBIN_SESSION_PLATFORM=discord', async () => {
  const db = await fresh();
  // Seed discord per-context row.
  await db
    .query(
      surql`UPSERT persona:singleton MERGE ${{
        comm_style_contexts: {
          discord: makeDiscordCtxRow({ tone: 'verbose' }),
          terminal: null,
          web: null,
        },
      }}`,
    )
    .collect();

  const saved = process.env.ROBIN_SESSION_PLATFORM;
  process.env.ROBIN_SESSION_PLATFORM = 'discord';
  try {
    const tool = createGetCommStyleTool({ db });
    const result = await tool.handler({});
    assert.equal(result.synthesized, true);
    assert.equal(result.tone, 'verbose', 'env=discord should route to discord per-context row');
    assert.equal(result.context, 'discord');
  } finally {
    if (saved !== undefined) process.env.ROBIN_SESSION_PLATFORM = saved;
    else delete process.env.ROBIN_SESSION_PLATFORM;
  }
  await close(db);
});

test('commstyle-show CLI: defaults to terminal context when env unset', async () => {
  // Import here to avoid side-effects at module load.
  const { commstyleShow } = await import(
    '../../runtime/cli/commands/commstyle-show.js'
  );
  const db = await fresh();
  // Inject a fake getCommStyle that returns a terse row, and context override.
  const lines = [];
  await commstyleShow([], {
    out: (s) => lines.push(s),
    context: 'terminal',
    getCommStyle: async () => ({
      tone: 'terse',
      formality: 'casual',
      emoji_ok: false,
      direct_feedback_ok: true,
      code_comment_density: 'minimal',
      summary_style: 'bullets',
      confidence: 0.75,
      last_synthesized_at: new Date('2026-01-01T00:00:00.000Z'),
      evidence: ['events:1', 'events:2'],
    }),
  });
  assert.ok(lines.some((l) => l.startsWith('context: terminal')), 'should output context line');
  assert.ok(lines.some((l) => l.startsWith('tone: terse')), 'should output tone');
  assert.ok(lines.some((l) => l.startsWith('evidence: 2 event(s)')), 'should output evidence count');
  await close(db);
});
