import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { getPersona, updatePersonaFields } from '../../cognition/memory/persona.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

// Spec §1.2 "persona MERGE serial": under the old `UPSERT … MERGE`, two
// concurrent writers to disjoint top-level keys could lose a write because
// MERGE is record-level — the second writer reads the record, merges in its
// keys, and writes the whole value back, clobbering the first writer's
// sibling key. The C2 refactor to `UPDATE … SET k = $v` is field-local;
// concurrent writers to disjoint keys cannot clobber each other.

test('concurrent updatePersonaFields writes to disjoint keys both land (no clobber)', async () => {
  const db = await fresh();
  // Two simulated callers — one writes comm_style, one writes calibration —
  // racing through the same db handle.
  const a = updatePersonaFields(db, { comm_style: { tone: 'concise' } });
  const b = updatePersonaFields(db, { calibration: { ece: 0.04 } });
  await Promise.all([a, b]);
  const p = await getPersona(db);
  assert.ok(p, 'persona row must exist');
  assert.deepEqual(p.comm_style, { tone: 'concise' }, 'comm_style preserved');
  assert.deepEqual(p.calibration, { ece: 0.04 }, 'calibration preserved');
  await close(db);
});

test('many concurrent writers to disjoint keys all land', async () => {
  const db = await fresh();
  // persona is SCHEMAFULL — use only declared fields (see 0001-init.surql:
  // name, display_name, pronouns, timezone, interests, comm_style,
  // calibration, meta).
  const writes = [
    updatePersonaFields(db, { comm_style: { tone: 'concise' } }),
    updatePersonaFields(db, { calibration: { ece: 0.04 } }),
    updatePersonaFields(db, { interests: ['lemon-lime'] }),
    updatePersonaFields(db, { pronouns: 'they/them' }),
    updatePersonaFields(db, { timezone: 'America/New_York' }),
  ];
  await Promise.all(writes);
  const p = await getPersona(db);
  assert.deepEqual(p.comm_style, { tone: 'concise' });
  assert.deepEqual(p.calibration, { ece: 0.04 });
  assert.deepEqual(p.interests, ['lemon-lime']);
  assert.equal(p.pronouns, 'they/them');
  assert.equal(p.timezone, 'America/New_York');
  await close(db);
});
