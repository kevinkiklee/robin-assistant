import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamProcess } from '../../src/dream/pipeline.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createListRulesTool } from '../../src/mcp/tools/list-rules.js';
import { createUpdateRuleTool } from '../../src/mcp/tools/update-rule.js';

test('correction → dream → list_rules pending → approve → list_rules active', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  for (let i = 0; i < 3; i++) {
    await recordEvent(db, e, {
      source: 'manual',
      content: 'be more concise',
      meta: { kind: 'correction' },
    });
  }
  const host = {
    invokeLLM: async () => ({
      content: JSON.stringify({
        propose: true,
        rule_text: 'Prefer concise responses',
        confidence: 0.9,
        candidates: [],
        promote: false,
      }),
      usage: {},
    }),
  };
  await dreamProcess(db, host, e);

  const list = createListRulesTool({ db });
  const update = createUpdateRuleTool({ db });

  const pending = await list.handler({ status: 'pending' });
  assert.ok(pending.pending.length >= 1);

  await update.handler({ id: pending.pending[0].id, action: 'approve' });

  const active = await list.handler({ status: 'active' });
  assert.ok(active.active.length >= 1);
  assert.match(active.active[0].content, /concise/i);
  await close(db);
});
