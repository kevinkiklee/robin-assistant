import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import installPointerPresent from '../../../runtime/invariants/install.pointer-present.js';
import { makeTestCtx, withTempStateFile } from '../../helpers/invariant-fixtures.js';

const POINTER_VERSION = 1;

function setEnv(primary, fallback) {
  process.env.ROBIN_POINTER_PATH = primary;
  if (fallback) {
    process.env.ROBIN_POINTER_FALLBACK_PATH = fallback;
  } else {
    delete process.env.ROBIN_POINTER_FALLBACK_PATH;
  }
}

function clearEnv() {
  delete process.env.ROBIN_POINTER_PATH;
  delete process.env.ROBIN_POINTER_FALLBACK_PATH;
}

function writePointer(p, home, version = POINTER_VERSION) {
  writeFileSync(
    p,
    JSON.stringify({ version, home, installedAt: '2026-05-15T00:00:00Z', installedBy: 'test' }),
  );
}

test('check passes when single pointer (env override) exists', () =>
  withTempStateFile(async ({ dir }) => {
    const p = `${dir}/.robin-home`;
    writePointer(p, '/tmp/some/home');
    setEnv(p);
    try {
      const r = await installPointerPresent.check();
      assert.equal(r.ok, true);
      assert.equal(r.evidence.home, '/tmp/some/home');
    } finally {
      clearEnv();
    }
  }));

test('check fails when pointer missing', () =>
  withTempStateFile(async ({ dir }) => {
    const p = `${dir}/.robin-home-missing`;
    setEnv(p);
    try {
      const r = await installPointerPresent.check();
      assert.equal(r.ok, false);
      assert.equal(r.error, 'all_pointers_missing');
    } finally {
      clearEnv();
    }
  }));

test('check fails on malformed JSON', () =>
  withTempStateFile(async ({ dir }) => {
    const p = `${dir}/.robin-home`;
    writeFileSync(p, '{ not json');
    setEnv(p);
    try {
      const r = await installPointerPresent.check();
      assert.equal(r.ok, false);
      assert.equal(r.error, 'all_pointers_unreadable');
    } finally {
      clearEnv();
    }
  }));

test('check fails on wrong version', () =>
  withTempStateFile(async ({ dir }) => {
    const p = `${dir}/.robin-home`;
    writePointer(p, '/tmp/home', 999);
    setEnv(p);
    try {
      const r = await installPointerPresent.check();
      assert.equal(r.ok, false);
    } finally {
      clearEnv();
    }
  }));

test('check detects divergent pointers', () =>
  withTempStateFile(async ({ dir }) => {
    const primary = `${dir}/.robin-home`;
    const fallback = `${dir}/install.json`;
    writePointer(primary, '/tmp/home-a');
    writePointer(fallback, '/tmp/home-b');
    // Custom env: use two-path setup via clobbering the location resolution.
    // Set both env vars to take effect.
    process.env.ROBIN_POINTER_PATH = primary;
    process.env.ROBIN_POINTER_FALLBACK_PATH = fallback;
    // But ROBIN_POINTER_PATH currently collapses to single read. We need to use
    // the default branch. Reset and use ROBIN_PACKAGE_ROOT_OVERRIDE.
    delete process.env.ROBIN_POINTER_PATH;
    process.env.ROBIN_PACKAGE_ROOT_OVERRIDE = dir;
    // .robin-home is at <dir>/.robin-home already (primary)
    // fallback is /<dir>/install.json
    process.env.ROBIN_POINTER_FALLBACK_PATH = fallback;
    try {
      const r = await installPointerPresent.check();
      assert.equal(r.ok, false);
      assert.equal(r.error, 'pointer_divergence');
      assert.deepEqual([...r.evidence.homes].sort(), ['/tmp/home-a', '/tmp/home-b']);
    } finally {
      delete process.env.ROBIN_PACKAGE_ROOT_OVERRIDE;
      delete process.env.ROBIN_POINTER_FALLBACK_PATH;
    }
  }));

test('check detects partial-missing when one of two pointers absent', () =>
  withTempStateFile(async ({ dir }) => {
    const primary = `${dir}/.robin-home`;
    const fallback = `${dir}/install.json`;
    writePointer(primary, '/tmp/home');
    // Don't write fallback
    process.env.ROBIN_PACKAGE_ROOT_OVERRIDE = dir;
    process.env.ROBIN_POINTER_FALLBACK_PATH = fallback;
    try {
      const r = await installPointerPresent.check();
      assert.equal(r.ok, false);
      assert.equal(r.error, 'pointer_partial_missing');
    } finally {
      delete process.env.ROBIN_PACKAGE_ROOT_OVERRIDE;
      delete process.env.ROBIN_POINTER_FALLBACK_PATH;
    }
  }));

test('repair restores the missing pointer from surviving one', () =>
  withTempStateFile(async ({ dir }) => {
    const primary = `${dir}/.robin-home`;
    const fallback = `${dir}/install.json`;
    writePointer(primary, '/tmp/home');
    process.env.ROBIN_PACKAGE_ROOT_OVERRIDE = dir;
    process.env.ROBIN_POINTER_FALLBACK_PATH = fallback;
    try {
      const r = await installPointerPresent.repair(makeTestCtx({ dryRun: false }));
      assert.equal(r.repaired, true);
      assert.equal(r.action, 'pointers_synced');
      assert.ok(existsSync(fallback), 'fallback should now exist');
      const parsed = JSON.parse(readFileSync(fallback, 'utf8'));
      assert.equal(parsed.home, '/tmp/home');
    } finally {
      delete process.env.ROBIN_PACKAGE_ROOT_OVERRIDE;
      delete process.env.ROBIN_POINTER_FALLBACK_PATH;
    }
  }));

test('repair dry-run does not write', () =>
  withTempStateFile(async ({ dir }) => {
    const primary = `${dir}/.robin-home`;
    const fallback = `${dir}/install.json`;
    writePointer(primary, '/tmp/home');
    process.env.ROBIN_PACKAGE_ROOT_OVERRIDE = dir;
    process.env.ROBIN_POINTER_FALLBACK_PATH = fallback;
    try {
      const r = await installPointerPresent.repair(makeTestCtx({ dryRun: true }));
      assert.equal(r.repaired, false);
      assert.equal(r.action, 'would_sync_pointers');
      assert.equal(existsSync(fallback), false, 'dry-run should not create fallback');
    } finally {
      delete process.env.ROBIN_PACKAGE_ROOT_OVERRIDE;
      delete process.env.ROBIN_POINTER_FALLBACK_PATH;
    }
  }));

test('repair refuses when no pointer survives', () =>
  withTempStateFile(async ({ dir }) => {
    const primary = `${dir}/.robin-home-none`;
    process.env.ROBIN_POINTER_PATH = primary;
    try {
      const r = await installPointerPresent.repair(makeTestCtx({ dryRun: false }));
      assert.equal(r.repaired, false);
      assert.match(r.error, /run: robin install/);
    } finally {
      clearEnv();
    }
  }));

test('repair: idempotent — second invocation is a no-op', () =>
  withTempStateFile(async ({ dir }) => {
    const primary = `${dir}/.robin-home`;
    const fallback = `${dir}/install.json`;
    writePointer(primary, '/tmp/home');
    process.env.ROBIN_PACKAGE_ROOT_OVERRIDE = dir;
    process.env.ROBIN_POINTER_FALLBACK_PATH = fallback;
    try {
      const r1 = await installPointerPresent.repair(makeTestCtx({ dryRun: false }));
      assert.equal(r1.repaired, true);
      const r2 = await installPointerPresent.repair(makeTestCtx({ dryRun: false }));
      assert.equal(r2.repaired, false, 'second run had nothing to do');
      assert.equal(r2.action, 'pointers_synced');
      assert.equal(r2.writes, 0);
    } finally {
      delete process.env.ROBIN_PACKAGE_ROOT_OVERRIDE;
      delete process.env.ROBIN_POINTER_FALLBACK_PATH;
    }
  }));

test('explain produces markdown', () => {
  const md = installPointerPresent.explain();
  assert.ok(md.includes('install.pointer_present'));
  assert.ok(md.includes('Symptom'));
  assert.ok(md.includes('Cause'));
  assert.ok(md.includes('Fix'));
});

test('explain with lastResult interpolates evidence', () => {
  const md = installPointerPresent.explain({ ok: false, evidence: { home: '/foo' } });
  assert.ok(md.includes('/foo'));
});
