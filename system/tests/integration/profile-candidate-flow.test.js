import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { createCandidate } from '../../cognition/dream/candidates.js';
import { getProfile } from '../../cognition/memory/persona.js';
import { approveCandidate } from '../../cognition/memory/rules.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

test('profile_update candidate → approve → profile:singleton updated', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const c = await createCandidate(db, {
    content: 'set name to Alice',
    kind: 'profile_update',
    signal_events: [],
    payload: { fields: { name: 'Alice', pronouns: 'he/him' } },
    confidence: 0.9,
  });
  await approveCandidate(db, c.id);
  const p = await getProfile(db);
  assert.equal(p.name, 'Alice');
  assert.equal(p.pronouns, 'he/him');
  await close(db);
});
