import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { getPersona, updatePersonaFields } from '../../cognition/memory/persona.js';
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

test('updatePersonaFields creates the singleton row when absent', async () => {
  const db = await fresh();
  await updatePersonaFields(db, { comm_style: { tone: 'concise' } });
  const p = await getPersona(db);
  assert.ok(p, 'persona row should exist');
  assert.deepEqual(p.comm_style, { tone: 'concise' });
  await close(db);
});

test('updatePersonaFields sets only the listed keys; untouched keys remain', async () => {
  const db = await fresh();
  await updatePersonaFields(db, { comm_style: { tone: 'concise' } });
  await updatePersonaFields(db, { calibration: { ece: 0.04 } });
  const p = await getPersona(db);
  assert.deepEqual(p.comm_style, { tone: 'concise' }, 'comm_style preserved');
  assert.deepEqual(p.calibration, { ece: 0.04 }, 'calibration added');
  await close(db);
});

test('updatePersonaFields supports multi-key calls in one statement', async () => {
  const db = await fresh();
  await updatePersonaFields(db, {
    comm_style: { tone: 'concise' },
    calibration: { ece: 0.04 },
  });
  const p = await getPersona(db);
  assert.deepEqual(p.comm_style, { tone: 'concise' });
  assert.deepEqual(p.calibration, { ece: 0.04 });
  await close(db);
});

test('updatePersonaFields with empty fields object is a no-op (does not throw)', async () => {
  const db = await fresh();
  await updatePersonaFields(db, { comm_style: { tone: 'concise' } });
  await updatePersonaFields(db, {});
  const p = await getPersona(db);
  assert.deepEqual(p.comm_style, { tone: 'concise' });
  await close(db);
});

test('updatePersonaFields rejects non-object input', async () => {
  const db = await fresh();
  await assert.rejects(() => updatePersonaFields(db, null), /fields/i);
  await assert.rejects(() => updatePersonaFields(db, 'oops'), /fields/i);
  await close(db);
});

test('uses UPDATE … SET (not UPSERT … MERGE) under the hood', async () => {
  // Source-level guard so a future refactor can't silently regress to MERGE.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    resolve(import.meta.dirname, '../../cognition/memory/persona.js'),
    'utf8',
  );
  assert.doesNotMatch(src, /MERGE\s*\$\{?fields\}?/, 'must not use MERGE ${fields}');
  assert.match(src, /SET\s+/i, 'must build a SET clause');
});
