import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getProfile } from '../../src/memory/profile.js';
import { createCandidate } from '../../src/rules/candidates.js';
import { approveCandidate } from '../../src/rules/rules.js';

test('profile_update candidate → approve → profile:singleton updated', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const c = await createCandidate(db, {
    content: 'set name to Kevin',
    kind: 'profile_update',
    signal_events: [],
    payload: { fields: { name: 'Kevin', pronouns: 'he/him' } },
    confidence: 0.9,
  });
  await approveCandidate(db, c.id);
  const p = await getProfile(db);
  assert.equal(p.name, 'Kevin');
  assert.equal(p.pronouns, 'he/him');
  await close(db);
});
