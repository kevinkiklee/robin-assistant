import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { synthesizeCommStyle } from '../../src/jobs/comm-style.js';
import { createGetCommStyleTool } from '../../src/mcp/tools/get-comm-style.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

test('comm-style roundtrip: seed 5 corrections → synthesize → MCP tool reads', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const embedder = createStubEmbedder({ dimension: 1024 });

  // Seed 5 correction events using the production shape:
  //   source: 'manual', meta: { kind: 'correction' }
  // (record_correction MCP tool writes this exact shape — verified in
  //  src/mcp/tools/record-correction.js line 27)
  // ts is READONLY/DEFAULT time::now() so we do not set it; the synthesis
  // cutoff is 30 days ago so freshly-created records will pass the WHERE clause.
  for (let i = 0; i < 5; i++) {
    const emb = Array.from(await embedder.embed(`be more terse ${i}`));
    await db
      .query(
        surql`CREATE events CONTENT ${{
          source: 'manual',
          content: `Be more terse on point ${i}. Skip preamble.`,
          content_hash: `c${i}`,
          meta: { kind: 'correction' },
          embedding: emb,
        }}`,
      )
      .collect();
  }

  // Stub LLM — returns the synthesized comm style as strict JSON.
  const host = {
    invokeLLM: async () => ({
      content: JSON.stringify({
        tone: 'terse',
        formality: 'casual',
        emoji_ok: false,
        direct_feedback_ok: true,
        code_comment_density: 'minimal',
        summary_style: 'bullets',
        confidence: 0.85,
        evidence_indices: [1, 2, 3],
      }),
    }),
  };

  const r = await synthesizeCommStyle(db, host);
  assert.equal(r.ok, true, `synthesize failed: ${JSON.stringify(r)}`);
  assert.equal(
    r.signals_used,
    5,
    `expected 5 signals, got ${r.signals_used} — seed shape mismatch?`,
  );

  // MCP tool returns populated shape with synthesized flag
  const tool = createGetCommStyleTool({ db });
  const tr = await tool.handler({});
  assert.equal(tr.tone, 'terse');
  assert.equal(tr.confidence, 0.85);
  assert.equal(tr.synthesized, true);
  assert.equal(tr.evidence.length, 3);

  await close(db);
});
