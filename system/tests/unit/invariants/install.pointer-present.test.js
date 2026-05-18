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

test('repair refuses when no pointer survives and no marker discoverable', () =>
  withTempStateFile(async ({ dir }) => {
    const primary = `${dir}/.robin-home-none`;
    process.env.ROBIN_POINTER_PATH = primary;
    try {
      // Inject an empty discovery result to deterministically exercise the
      // "no surviving pointer and no marker" branch — the default scan would
      // otherwise find this repo's real user-data and falsely "recover".
      const r = await installPointerPresent.repair(
        makeTestCtx({ dryRun: false, discoverHomes: () => [] }),
      );
      assert.equal(r.repaired, false);
      assert.match(r.error, /run: robin install/);
      assert.deepEqual(r.evidence.candidates, []);
    } finally {
      clearEnv();
    }
  }));

test('repair recovers pointer from .marker.json when both pointers missing', () =>
  withTempStateFile(async ({ dir }) => {
    const userData = `${dir}/recovered-user-data`;
    const primary = `${dir}/.robin-home-recover`;
    const fallback = `${dir}/install-recover.json`;
    process.env.ROBIN_POINTER_PATH = primary;
    process.env.ROBIN_POINTER_FALLBACK_PATH = fallback;
    try {
      const r = await installPointerPresent.repair(
        makeTestCtx({
          dryRun: false,
          discoverHomes: () => [
            { path: userData, kind: 'marker', lastUsed: '2026-05-18T00:00:00Z' },
          ],
        }),
      );
      assert.equal(r.repaired, true, JSON.stringify(r));
      assert.equal(r.action, 'pointers_recovered_from_marker');
      assert.equal(r.evidence.source, userData);
      // Both pointer files now exist and reference the recovered home.
      assert.equal(existsSync(primary), true);
      assert.equal(existsSync(fallback), true);
      const parsed = JSON.parse(readFileSync(primary, 'utf8'));
      assert.equal(parsed.home, userData);
      assert.equal(parsed.installedBy, 'invariant.install.pointer_present');
    } finally {
      clearEnv();
    }
  }));

test('repair dry-run reports recovery plan without writing', () =>
  withTempStateFile(async ({ dir }) => {
    const userData = `${dir}/dry-recovered-user-data`;
    const primary = `${dir}/.robin-home-dryrun-recover`;
    process.env.ROBIN_POINTER_PATH = primary;
    try {
      const r = await installPointerPresent.repair(
        makeTestCtx({
          dryRun: true,
          discoverHomes: () => [
            { path: userData, kind: 'marker', lastUsed: '2026-05-18T00:00:00Z' },
          ],
        }),
      );
      assert.equal(r.repaired, false);
      assert.equal(r.action, 'would_recover_from_marker');
      assert.equal(r.plan.canonical_home, userData);
      assert.equal(existsSync(primary), false, 'dry-run must not write');
    } finally {
      clearEnv();
    }
  }));

test('repair prefers the most-recent marker when multiple are discovered', () =>
  withTempStateFile(async ({ dir }) => {
    const oldHome = `${dir}/old-home`;
    const newHome = `${dir}/new-home`;
    const primary = `${dir}/.robin-home-multi`;
    process.env.ROBIN_POINTER_PATH = primary;
    try {
      const r = await installPointerPresent.repair(
        makeTestCtx({
          dryRun: false,
          discoverHomes: () => [
            { path: oldHome, kind: 'marker', lastUsed: '2025-01-01T00:00:00Z' },
            { path: newHome, kind: 'marker', lastUsed: '2026-05-18T00:00:00Z' },
            { path: `${dir}/legacy`, kind: 'legacy', lastUsed: '2026-05-18T00:00:00Z' },
          ],
        }),
      );
      assert.equal(r.repaired, true);
      assert.equal(r.evidence.source, newHome, 'should prefer most-recent marker');
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
