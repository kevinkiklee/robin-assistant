/**
 * Integration tests for non-interactive install flags:
 *   --yes, --existing <path>, --on-existing=move|copy|ignore|abort, --force
 *
 * Tests call planInstallHome() directly for fast, isolated coverage without
 * running the full install pipeline (which requires an embedder profile,
 * migrations, hooks, etc.).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseArgs } from '../../runtime/cli/args.js';
import { planInstallHome } from '../../runtime/cli/commands/install.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), `robin-ni-${prefix}-`));
}

/** Seed a directory so discoverExistingHomes recognises it as a Robin home. */
function seedRobinHome(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.robin-data'), JSON.stringify({ version: 1, createdAt: 'x' }));
}

/** Seed a legacy Robin home (no .robin-data marker, but has db/CURRENT). */
function seedLegacyHome(dir) {
  mkdirSync(join(dir, 'db'), { recursive: true });
  writeFileSync(join(dir, 'db', 'CURRENT'), 'rocksdb');
}

function makeArgs(argv) {
  return parseArgs(argv);
}

// Empty discovery stub: returns no existing Robin homes.
const noExistingHomes = () => [];

// ---------------------------------------------------------------------------
// Test 1: --yes (no --home) picks option 1 default (packageRoot/user-data)
// ---------------------------------------------------------------------------

test('planInstallHome --yes picks packageRoot/user-data when no --home', async () => {
  const packageRoot = tmpDir('pkgroot');
  const homeDir = tmpDir('home');
  try {
    const args = makeArgs(['--yes', '--profile', 'mxbai-1024']);
    const result = await planInstallHome({
      args,
      interactive: false,
      packageRoot,
      homedir: homeDir,
      discoverFn: noExistingHomes,
    });
    assert.strictEqual(result.home, join(packageRoot, 'user-data'));
    assert.strictEqual(result.action, 'picked-default');
    assert.strictEqual(result.migrationPlan, undefined);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: --home X --yes picks X (--home overrides the default picker)
// ---------------------------------------------------------------------------

test('planInstallHome --home X --yes returns X as home', async () => {
  const packageRoot = tmpDir('pkgroot');
  const homeDir = tmpDir('home');
  const chosenHome = tmpDir('chosen');
  try {
    const args = makeArgs(['--home', chosenHome, '--yes']);
    const result = await planInstallHome({
      args,
      interactive: false,
      packageRoot,
      homedir: homeDir,
      discoverFn: noExistingHomes,
    });
    assert.strictEqual(result.home, chosenHome);
    assert.strictEqual(result.action, 'picked');
    assert.strictEqual(result.migrationPlan, undefined);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(chosenHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3: --home X --existing Y --on-existing=move → migrationPlan move
// ---------------------------------------------------------------------------

test('planInstallHome --home X --existing Y --on-existing=move returns move plan', async () => {
  const packageRoot = tmpDir('pkgroot');
  const homeDir = tmpDir('home');
  const target = join(tmpDir('target-parent'), 'robin-target'); // does not exist yet
  const source = tmpDir('source');
  seedRobinHome(source);
  try {
    const args = makeArgs(['--home', target, '--existing', source, '--on-existing', 'move']);
    const result = await planInstallHome({
      args,
      interactive: false,
      packageRoot,
      homedir: homeDir,
    });
    assert.strictEqual(result.home, target);
    assert.ok(result.migrationPlan, 'expected a migration plan');
    assert.strictEqual(result.migrationPlan.abort, undefined);
    assert.strictEqual(result.migrationPlan.ignore, undefined);
    assert.strictEqual(result.migrationPlan.from, source);
    assert.strictEqual(result.migrationPlan.mode, 'move');
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
    // target may not exist; clean up its parent
    const targetParent = join(target, '..');
    if (existsSync(targetParent)) rmSync(targetParent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4: --home X --existing Y --on-existing=copy → migrationPlan copy
// ---------------------------------------------------------------------------

test('planInstallHome --home X --existing Y --on-existing=copy returns copy plan', async () => {
  const packageRoot = tmpDir('pkgroot');
  const homeDir = tmpDir('home');
  const target = join(tmpDir('target-parent'), 'robin-target');
  const source = tmpDir('source');
  seedRobinHome(source);
  try {
    const args = makeArgs(['--home', target, '--existing', source, '--on-existing=copy']);
    const result = await planInstallHome({
      args,
      interactive: false,
      packageRoot,
      homedir: homeDir,
    });
    assert.strictEqual(result.migrationPlan?.from, source);
    assert.strictEqual(result.migrationPlan?.mode, 'copy');
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
    const targetParent = join(target, '..');
    if (existsSync(targetParent)) rmSync(targetParent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 5: --home X --existing Y (no --on-existing) → abort plan (default)
// ---------------------------------------------------------------------------

test('planInstallHome --home X --existing Y (no --on-existing) defaults to abort', async () => {
  const packageRoot = tmpDir('pkgroot');
  const homeDir = tmpDir('home');
  const target = tmpDir('target');
  const source = tmpDir('source');
  seedRobinHome(source);
  try {
    const args = makeArgs(['--home', target, '--existing', source]);
    const result = await planInstallHome({
      args,
      interactive: false,
      packageRoot,
      homedir: homeDir,
    });
    assert.ok(result.migrationPlan?.abort === true, 'expected abort: true');
    assert.match(result.migrationPlan.reason, /existing data found at/);
    assert.match(result.migrationPlan.reason, /aborting/);
    assert.match(
      result.migrationPlan.reason,
      new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 6: --home X --existing Y --on-existing=ignore → ignore plan
// ---------------------------------------------------------------------------

test('planInstallHome --home X --existing Y --on-existing=ignore returns ignore plan', async () => {
  const packageRoot = tmpDir('pkgroot');
  const homeDir = tmpDir('home');
  const target = tmpDir('target');
  const source = tmpDir('source');
  seedRobinHome(source);
  try {
    const args = makeArgs(['--home', target, '--existing', source, '--on-existing=ignore']);
    const result = await planInstallHome({
      args,
      interactive: false,
      packageRoot,
      homedir: homeDir,
    });
    assert.strictEqual(result.migrationPlan?.ignore, true);
    assert.strictEqual(result.migrationPlan?.abort, undefined);
    assert.strictEqual(result.migrationPlan?.from, undefined);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 7: no --existing, no prior Robin data → no migration plan
// ---------------------------------------------------------------------------

test('planInstallHome with no existing Robin data returns no migration plan', async () => {
  const packageRoot = tmpDir('pkgroot');
  const homeDir = tmpDir('home');
  const target = tmpDir('target');
  try {
    const args = makeArgs(['--home', target]);
    const result = await planInstallHome({
      args,
      interactive: false,
      packageRoot,
      homedir: homeDir,
      // Inject empty discovery to isolate from real filesystem state.
      discoverFn: noExistingHomes,
    });
    assert.strictEqual(result.migrationPlan, undefined);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 8: --existing Y with legacy (db/CURRENT) layout also triggers abort
// ---------------------------------------------------------------------------

test('planInstallHome detects legacy home (db/CURRENT) via --existing and aborts by default', async () => {
  const packageRoot = tmpDir('pkgroot');
  const homeDir = tmpDir('home');
  const target = tmpDir('target');
  const source = tmpDir('source');
  seedLegacyHome(source);
  try {
    const args = makeArgs(['--home', target, '--existing', source]);
    const result = await planInstallHome({
      args,
      interactive: false,
      packageRoot,
      homedir: homeDir,
    });
    assert.strictEqual(result.migrationPlan?.abort, true);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 9: --existing pointing to a path with no Robin data → no migration plan
// ---------------------------------------------------------------------------

test('planInstallHome --existing Y where Y has no Robin data returns no migration plan', async () => {
  const packageRoot = tmpDir('pkgroot');
  const homeDir = tmpDir('home');
  const target = tmpDir('target');
  const source = tmpDir('source'); // empty; not a Robin home
  try {
    const args = makeArgs(['--home', target, '--existing', source]);
    const result = await planInstallHome({
      args,
      interactive: false,
      packageRoot,
      homedir: homeDir,
    });
    assert.strictEqual(result.migrationPlan, undefined);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 10: --yes in non-interactive context → same as no-args non-interactive
// ---------------------------------------------------------------------------

test('planInstallHome --yes in non-interactive context picks default home', async () => {
  const packageRoot = tmpDir('pkgroot');
  const homeDir = tmpDir('home');
  try {
    const args = makeArgs([
      '--yes',
      '--no-mcp',
      '--no-hooks',
      '--no-migrate',
      '--profile',
      'mxbai-1024',
    ]);
    const result = await planInstallHome({
      args,
      interactive: false,
      packageRoot,
      homedir: homeDir,
      discoverFn: noExistingHomes,
    });
    assert.strictEqual(result.home, join(packageRoot, 'user-data'));
    assert.strictEqual(result.action, 'picked-default');
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
