import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { synthesizeCommStyle } from '../../cognition/jobs/comm-style.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createGetCommStyleTool } from '../../io/mcp/tools/get-comm-style.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

test('comm-style roundtrip: seed 5 corrections → synthesize → MCP tool reads', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const embedder = createStubEmbedder({ dimension: 1024 });

  // Seed 5 correction events using the production shape:
  //   source: 'manual', meta: { kind: 'correction' }
  // (record_correction MCP tool writes this exact shape.)
  // The embedding column was removed in the redesign — recordEvent writes the
  // embedding into the per-profile surface table for us.
  const { recordEvent } = await import('../../io/capture/record-event.js');
  for (let i = 0; i < 5; i++) {
    await recordEvent(db, embedder, {
      source: 'manual',
      content: `Be more terse on point ${i}. Skip preamble.`,
      meta: { kind: 'correction' },
    });
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
