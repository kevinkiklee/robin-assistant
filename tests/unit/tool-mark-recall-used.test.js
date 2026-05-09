import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createMarkRecallUsedTool } from '../../src/mcp/tools/mark-recall-used.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

async function seedRecallEvent(db) {
  const e = createStubEmbedder({ dimension: 384 });
  const evt1 = await recordEvent(db, e, { source: 'cli', content: 'a' });
  const evt2 = await recordEvent(db, e, { source: 'cli', content: 'b' });
  const queryVec = Array.from(await e.embed('test'));
  const [created] = await db
    .query(
      surql`CREATE recall_events CONTENT ${{
        query_text: 'test',
        query_vec: queryVec,
        hit_ids: [evt1.id, evt2.id],
        hit_dists: [0.1, 0.2],
        hit_used: [false, false],
      }}`,
    )
    .collect();
  return {
    recallEventId: (Array.isArray(created) ? created[0] : created).id,
    hitIds: [String(evt1.id), String(evt2.id)],
  };
}

test('mark_recall_used sets hit_used[i]=true for IDs in used_hit_ids', async () => {
  const db = await fresh();
  const { recallEventId, hitIds } = await seedRecallEvent(db);
  const tool = createMarkRecallUsedTool({ db });
  const r = await tool.handler({
    recall_event_id: String(recallEventId),
    used_hit_ids: [hitIds[0]],
  });
  assert.equal(r.updated, 1);
  const [rows] = await db.query(surql`SELECT hit_used FROM ${recallEventId}`).collect();
  assert.deepEqual(rows[0].hit_used, [true, false]);
  await close(db);
});

test('mark_recall_used silently ignores out-of-set IDs', async () => {
  const db = await fresh();
  const { recallEventId, hitIds } = await seedRecallEvent(db);
  const tool = createMarkRecallUsedTool({ db });
  const r = await tool.handler({
    recall_event_id: String(recallEventId),
    used_hit_ids: ['events:nonexistent', hitIds[1]],
  });
  assert.equal(r.updated, 1);
  await close(db);
});

test('mark_recall_used throws when recall_event_id not found', async () => {
  const db = await fresh();
  const tool = createMarkRecallUsedTool({ db });
  await assert.rejects(
    tool.handler({ recall_event_id: 'recall_events:nonexistent', used_hit_ids: [] }),
    /not found/i,
  );
  await close(db);
});
