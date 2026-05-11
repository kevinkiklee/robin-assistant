// tests/integration/knowledge-ops-roundtrip.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createAuditTool } from '../../io/mcp/tools/audit.js';
import { createIngestTool } from '../../io/mcp/tools/ingest.js';
import { createLintTool } from '../../io/mcp/tools/lint.js';

import { writeConfig as __wc } from '../../config/paths.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

test('knowledge ops roundtrip: ingest → lint sees orphan → audit sees no pairs', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const embedder = createStubEmbedder({ dimension: 1024 });

  const llmStub = {
    invokeLLM: async (_msgs, opts) => {
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

  // 2. Lint should NOT flag the Mercury entity as orphan — the ingest creates
  // an `about` edge from the new knowledge memo to the entity (subject_name
  // routes through store.note, which emits the edge automatically). This is
  // the new edges-table behaviour; the orphan check considers any inbound
  // edge as non-orphan.
  const lr = await lint.handler({});
  const orphans = lr.issues.filter((i) => i.kind === 'orphan_entity');
  assert.equal(orphans.length, 0, 'entity with inbound about-edge should not be flagged');

  // 3. Audit with only one knowledge row: no pairs possible.
  const ar = await audit.handler({});
  assert.equal(ar.ok, true);
  assert.equal(ar.pairs_checked, 0);

  await close(db);
});
