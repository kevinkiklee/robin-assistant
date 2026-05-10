import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createYouTubeListLikedTool } from '../../src/integrations/youtube/tools/youtube-list-liked.js';
import { createYouTubeListSubscriptionsTool } from '../../src/integrations/youtube/tools/youtube-list-subscriptions.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('youtube_list_subscriptions filters by kind', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'youtube',
        content: 'sub: A',
        ts: new Date('2026-05-09'),
        external_id: 'sub:c1',
        meta: { kind: 'subscription' },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'youtube',
        content: 'liked: V',
        ts: new Date('2026-05-09'),
        external_id: 'liked:v1',
        meta: { kind: 'liked_video' },
      }}`,
    )
    .collect();
  const t = createYouTubeListSubscriptionsTool({ db });
  const r = await t.handler({});
  assert.equal(r.subscriptions.length, 1);
  await close(db);
});

test('youtube_list_liked filters by kind', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'youtube',
        content: 'liked: V',
        ts: new Date('2026-05-09'),
        external_id: 'liked:v1',
        meta: { kind: 'liked_video' },
      }}`,
    )
    .collect();
  const t = createYouTubeListLikedTool({ db });
  const r = await t.handler({});
  assert.equal(r.liked.length, 1);
  await close(db);
});
