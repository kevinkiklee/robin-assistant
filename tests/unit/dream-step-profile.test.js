import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamStepProfile } from '../../src/dream/step-profile.js';

test('dreamStepProfile returns 0 proposed on empty DB', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const host = { invokeLLM: async () => ({ content: '{"candidates":[]}', usage: {} }) };
  const r = await dreamStepProfile(db, host);
  assert.equal(r.proposed, 0);
  await close(db);
});
