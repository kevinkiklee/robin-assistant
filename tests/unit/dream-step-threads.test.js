import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamStepThreads } from '../../src/dream/step-threads.js';

test('dreamStepThreads returns 0 created on empty DB', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const r = await dreamStepThreads(db);
  assert.equal(r.created, 0);
  await close(db);
});
