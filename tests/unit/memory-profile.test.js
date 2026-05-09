import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getProfile, updateProfileFields } from '../../src/memory/profile.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('getProfile returns null for fresh DB', async () => {
  const db = await fresh();
  const p = await getProfile(db);
  assert.equal(p, null);
  await close(db);
});

test('updateProfileFields creates singleton on first call', async () => {
  const db = await fresh();
  await updateProfileFields(db, { name: 'Kevin', pronouns: 'he/him' });
  const p = await getProfile(db);
  assert.equal(p.name, 'Kevin');
  assert.equal(p.pronouns, 'he/him');
  await close(db);
});

test('updateProfileFields merges into existing singleton', async () => {
  const db = await fresh();
  await updateProfileFields(db, { name: 'Kevin' });
  await updateProfileFields(db, { timezone: 'America/New_York' });
  const p = await getProfile(db);
  assert.equal(p.name, 'Kevin');
  assert.equal(p.timezone, 'America/New_York');
  await close(db);
});
