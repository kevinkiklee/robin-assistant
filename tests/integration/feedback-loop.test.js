import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createRepeatQueryDetector } from '../../src/mcp/implicit-signals.js';
import { createMarkRecallUsedTool } from '../../src/mcp/tools/mark-recall-used.js';
import { createRecallTool } from '../../src/mcp/tools/recall.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

test('recall → mark_recall_used round-trip captures feedback signal', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'apple' });
  await recordEvent(db, e, { source: 'cli', content: 'banana' });
  await recordEvent(db, e, { source: 'cli', content: 'cherry' });

  const recallTool = createRecallTool({
    db,
    embedder: e,
    detector: createRepeatQueryDetector({}),
    getSessionId: () => 'sess-1',
  });
  const markTool = createMarkRecallUsedTool({ db });

  const recallResult = await recallTool.handler({ query: 'apple' });
  assert.ok(recallResult.recall_event_id);
  assert.ok(recallResult.hits.length >= 1);

  const usedHitId = recallResult.hits[0].id;
  const markResult = await markTool.handler({
    recall_event_id: recallResult.recall_event_id,
    used_hit_ids: [usedHitId],
  });
  assert.equal(markResult.updated, 1);

  // Verify the recall_events row has hit_used updated
  const [rows] = await db.query(surql`SELECT hit_used FROM recall_events`).collect();
  assert.ok(rows[0].hit_used.some((u) => u === true));
  await close(db);
});
