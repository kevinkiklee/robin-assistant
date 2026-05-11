import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-introspection-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
__robinMkdirSync(__robinJoin(__robinTestHome, 'db'), { recursive: true });
__robinMkdirSync(__robinJoin(__robinTestHome, 'secrets'), { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('runIntrospection without baseline returns no_baseline finding, baselined=false', async () => {
  const db = await fresh();
  const { runIntrospection } = await import(
    `../../runtime/daemon/introspection.js?cb=${Date.now()}`
  );
  const r = await runIntrospection(db, { includeSupervisor: false });
  assert.equal(r.ok, true);
  assert.equal(r.baselined, false);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, 'no_baseline');
  assert.match(r.findings[0].detail, /manifest\.json/);
  await close(db);
});

test('runIntrospection with fresh baseline returns ok=true, no findings, baselined=true', async () => {
  const db = await fresh();
  const { computeManifest, writeManifest } = await import(
    `../../runtime/install/manifest.js?cb=${Date.now()}`
  );
  const { runIntrospection, readLastIntrospection } = await import(
    `../../runtime/daemon/introspection.js?cb=${Date.now()}`
  );

  const baseline = await computeManifest({ includeSupervisor: false });
  await writeManifest(baseline);

  const r = await runIntrospection(db, { includeSupervisor: false });
  assert.equal(r.ok, true);
  assert.equal(r.baselined, true);
  assert.deepEqual(r.findings, []);

  // Persisted runtime_introspection_state row.
  const last = await readLastIntrospection(db);
  assert.ok(last, 'introspection state row written');
  assert.equal(last.ok, true);
  assert.deepEqual(last.findings, []);
  assert.ok(last.checked_at, 'checked_at present');

  await close(db);
});

test('runIntrospection reports hash_drift when baseline file hash mutated', async () => {
  const db = await fresh();
  const { computeManifest, writeManifest } = await import(
    `../../runtime/install/manifest.js?cb=${Date.now()}`
  );
  const { runIntrospection } = await import(
    `../../runtime/daemon/introspection.js?cb=${Date.now()}`
  );

  const baseline = await computeManifest({ includeSupervisor: false });
  // Mutate the bin/robin entry's hash so live recompute disagrees.
  const tampered = structuredClone(baseline);
  const target = tampered.files.find((f) => f.path === 'system/bin/robin');
  assert.ok(target, 'system/bin/robin in baseline');
  const expectedHash = 'a'.repeat(64);
  target.sha256 = expectedHash;
  await writeManifest(tampered);

  const r = await runIntrospection(db, { includeSupervisor: false });
  assert.equal(r.ok, false);
  assert.equal(r.baselined, true);
  const drift = r.findings.find((f) => f.kind === 'hash_drift' && f.path === 'system/bin/robin');
  assert.ok(drift, 'hash_drift finding for bin/robin');
  assert.equal(drift.expected, expectedHash);
  assert.match(drift.actual, /^[0-9a-f]{64}$/);
  assert.notEqual(drift.actual, expectedHash);

  await close(db);
});

test('readLastIntrospection returns persisted state after a run', async () => {
  const db = await fresh();
  const { computeManifest, writeManifest } = await import(
    `../../runtime/install/manifest.js?cb=${Date.now()}`
  );
  const { runIntrospection, readLastIntrospection } = await import(
    `../../runtime/daemon/introspection.js?cb=${Date.now()}`
  );

  const baseline = await computeManifest({ includeSupervisor: false });
  await writeManifest(baseline);
  await runIntrospection(db, { includeSupervisor: false });

  const last = await readLastIntrospection(db);
  assert.ok(last);
  assert.equal(last.ok, true);
  assert.ok(last.checked_at, 'has checked_at');
  await close(db);
});

test('readLastIntrospection returns null when no row exists', async () => {
  const db = await fresh();
  const { readLastIntrospection } = await import(
    `../../runtime/daemon/introspection.js?cb=${Date.now()}`
  );
  const last = await readLastIntrospection(db);
  assert.equal(last, null);
  await close(db);
});
