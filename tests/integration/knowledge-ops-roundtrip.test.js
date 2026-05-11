// tests/integration/knowledge-ops-roundtrip.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createAuditTool } from '../../src/mcp/tools/audit.js';
import { createIngestTool } from '../../src/mcp/tools/ingest.js';
import { createLintTool } from '../../src/mcp/tools/lint.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

test('knowledge ops roundtrip: ingest → lint sees orphan → audit sees no pairs', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const embedder = createStubEmbedder({ dimension: 1024 });

  const llmStub = {
    invokeLLM: async (msgs, opts) => {
      if (opts?.tier === 'balanced') {
        return { content: '{"contradict":false,"summary":"no overlap"}' };
      }
      // deep tier: ingest extraction
      return {
        content: JSON.stringify({
          entities: [{ name: 'Mercury', type: 'project', confidence: 0.9 }],
          edges: [],
          knowledge: [
            {
              content: 'Mercury is a project that launched in 2026',
              subject_name: 'Mercury',
              confidence: 0.8,
            },
          ],
        }),
      };
    },
  };

  const ingest = createIngestTool({ db, embedder, host: llmStub });
  const lint = createLintTool({ db });
  const audit = createAuditTool({ db, host: llmStub });

  // 1. Ingest a document
  const ing = await ingest.handler({
    content: 'Project Mercury launched in early 2026. It was led by the platform team.',
  });
  assert.equal(ing.ok, true);
  assert.equal(ing.entities_created, 1);
  assert.equal(ing.knowledge_created, 1);

  // 2. Lint should find an orphan entity (the Mercury entity has no inbound
  // edges because the LLM stub returned no edges).
  const lr = await lint.handler({});
  const orphans = lr.issues.filter((i) => i.kind === 'orphan_entity');
  assert.ok(orphans.length >= 1, 'expected at least one orphan_entity');

  // 3. Audit with only one knowledge row: no pairs possible.
  const ar = await audit.handler({});
  assert.equal(ar.ok, true);
  assert.equal(ar.pairs_checked, 0);

  await close(db);
});
