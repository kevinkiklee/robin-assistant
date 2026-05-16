// Verify that loadPerIntegrationInvariants() discovers `invariants/*.js`
// modules placed under a loaded integration's directory.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  getAllInvariants,
  INVARIANTS,
  loadPerIntegrationInvariants,
} from '../../../runtime/invariants/index.js';

async function makeFakeIntegration({ name, withInvariant = true, invariantName = null }) {
  const root = await mkdtemp(join(tmpdir(), 'robin-perint-'));
  const intDir = join(root, name);
  mkdirSync(intDir, { recursive: true });
  // Minimal manifest (the loader requires name + tools/sync/start to classify).
  writeFileSync(
    join(intDir, 'manifest.js'),
    `export const manifest = { name: '${name}', cadence: null, tools: [{ name: 'noop' }] };\n`,
    'utf8',
  );
  if (withInvariant) {
    const invDir = join(intDir, 'invariants');
    mkdirSync(invDir, { recursive: true });
    const invName = invariantName ?? `${name}.test_invariant`;
    writeFileSync(
      join(invDir, 'check.js'),
      `export default {
  name: '${invName}',
  level: 'warn',
  surface: 'integrations',
  phase: 'integrations',
  runWhen: { boot: { enabled: false }, heartbeat: { enabled: true }, doctor: { enabled: true }, postInstall: { enabled: false } },
  async check() { return { ok: true }; },
  explain() { return '### ${invName}\\n\\nFixture invariant.'; },
};\n`,
      'utf8',
    );
  }
  // Loader scans the parent dir, not the integration's own dir.
  return root;
}

test('loadPerIntegrationInvariants discovers invariants from loaded integrations', async () => {
  const root = await makeFakeIntegration({ name: 'fake_with_inv' });
  const found = await loadPerIntegrationInvariants([root]);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'fake_with_inv.test_invariant');
  assert.equal(typeof found[0].check, 'function');
});

test('loadPerIntegrationInvariants returns empty when no invariants/ subdir exists', async () => {
  const root = await makeFakeIntegration({ name: 'fake_no_inv', withInvariant: false });
  const found = await loadPerIntegrationInvariants([root]);
  assert.deepEqual(found, []);
});

test('loadPerIntegrationInvariants warns and skips broken modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'robin-perint-broken-'));
  const intDir = join(root, 'fake_broken');
  mkdirSync(join(intDir, 'invariants'), { recursive: true });
  writeFileSync(
    join(intDir, 'manifest.js'),
    "export const manifest = { name: 'fake_broken', cadence: null, tools: [{ name: 'noop' }] };\n",
    'utf8',
  );
  // Module with no default export.
  writeFileSync(join(intDir, 'invariants', 'naked.js'), 'export const foo = 1;\n', 'utf8');
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const found = await loadPerIntegrationInvariants([root]);
    assert.deepEqual(found, []);
  } finally {
    console.warn = orig;
  }
  assert.ok(warnings.some((w) => w.includes('fake_broken/naked.js')));
});

test('getAllInvariants returns INVARIANTS plus per-integration invariants, phase-ordered', async () => {
  const all = await getAllInvariants();
  // Every static invariant is present.
  for (const inv of INVARIANTS) {
    assert.ok(
      all.some((i) => i.name === inv.name),
      `static invariant ${inv.name} missing from getAllInvariants`,
    );
  }
  // No duplicate names.
  const names = all.map((i) => i.name);
  assert.equal(new Set(names).size, names.length, 'duplicate invariant name in getAllInvariants');
});
