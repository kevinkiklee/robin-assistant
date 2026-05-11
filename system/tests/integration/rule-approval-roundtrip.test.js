import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { dreamProcess } from '../../cognition/dream/pipeline.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';
import { createListRulesTool } from '../../io/mcp/tools/list-rules.js';
import { createUpdateRuleTool } from '../../io/mcp/tools/update-rule.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

test('correction → dream → list_rules pending → approve → list_rules active', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
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
