// Tests for the three brand-new invariants (no legacy probe to compare against).

import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import daemonHeartbeating from '../../../runtime/invariants/daemon.heartbeating.js';
import runtimeHooksSettingsPresent from '../../../runtime/invariants/runtime.hooks-settings-present.js';
import runtimeNodeVersionPinned from '../../../runtime/invariants/runtime.node-version-pinned.js';

const tmpRoot = join(tmpdir(), `robin-s4-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(tmpRoot, { recursive: true });
process.env.ROBIN_HOME = tmpRoot;
process.env.ROBIN_PACKAGE_ROOT_OVERRIDE = tmpRoot;
mkdirSync(join(tmpRoot, 'system', 'bin'), { recursive: true });
writeFileSync(join(tmpRoot, 'system', 'bin', 'robin-hook.sh'), '#!/usr/bin/env bash\n', {
  mode: 0o755,
});

// --- runtime.hooks_settings_present ---

test('hooks_settings_present: enabled=false when neither host dir exists', async () => {
  const oldHome = process.env.HOME;
  const empty = join(tmpRoot, 'empty-home');
  mkdirSync(empty, { recursive: true });
  process.env.HOME = empty;
  try {
    const ok = await runtimeHooksSettingsPresent.enabled();
    assert.equal(ok, false);
  } finally {
    process.env.HOME = oldHome;
  }
});

test('hooks_settings_present: check fails when hooks missing', async () => {
  const oldHome = process.env.HOME;
  const fakeHome = join(tmpRoot, 'fake-home');
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  writeFileSync(join(fakeHome, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
  process.env.HOME = fakeHome;
  try {
    const r = await runtimeHooksSettingsPresent.check();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'hooks_missing');
    assert.ok(r.evidence.missing.length > 0);
  } finally {
    process.env.HOME = oldHome;
  }
});

test('hooks_settings_present: check passes when all expected commands present', async () => {
  const oldHome = process.env.HOME;
  const fakeHome = join(tmpRoot, 'good-home');
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  const shim = join(tmpRoot, 'system', 'bin', 'robin-hook.sh');
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: `${shim} discretion` }] },
      ],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${shim} intuition` }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: `${shim} session-start` }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${shim} stop` }] }],
    },
  };
  writeFileSync(join(fakeHome, '.claude', 'settings.json'), JSON.stringify(settings));
  process.env.HOME = fakeHome;
  try {
    const r = await runtimeHooksSettingsPresent.check();
    assert.equal(r.ok, true, `expected ok=true, got error=${r.error}`);
  } finally {
    process.env.HOME = oldHome;
  }
});

// --- runtime.node_version_pinned ---

test('node_version_pinned: enabled=true when .npmrc has use-node-version', async () => {
  writeFileSync(join(tmpRoot, '.npmrc'), 'use-node-version=99.0.0\n');
  const ok = await runtimeNodeVersionPinned.enabled();
  assert.equal(ok, true);
});

test('node_version_pinned: check fails on mismatch', async () => {
  writeFileSync(join(tmpRoot, '.npmrc'), 'use-node-version=99.0.0\n');
  const r = await runtimeNodeVersionPinned.check();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'version_mismatch');
  assert.equal(r.evidence.pinned, '99.0.0');
});

test('node_version_pinned: check passes when versions match', async () => {
  const running = process.version.replace(/^v/, '');
  writeFileSync(join(tmpRoot, '.npmrc'), `use-node-version=${running}\n`);
  const r = await runtimeNodeVersionPinned.check();
  assert.equal(r.ok, true);
});

// --- daemon.heartbeating ---

test('daemon.heartbeating: fails when state file missing', async () => {
  // Ensure the state file path is in a place we don't write to
  const r = await daemonHeartbeating.check();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_state_file');
});

test('daemon.heartbeating: fails when state file is stale', async () => {
  const stateDir = join(tmpRoot, 'runtime');
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, 'invariants-state.json');
  writeFileSync(statePath, '{}');
  // Set mtime to 10 minutes ago
  const old = Date.now() / 1000 - 600;
  utimesSync(statePath, old, old);
  const r = await daemonHeartbeating.check();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'heartbeat_stale');
});

test('daemon.heartbeating: passes when state file is fresh', async () => {
  const stateDir = join(tmpRoot, 'runtime');
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, 'invariants-state.json');
  writeFileSync(statePath, '{}');
  const r = await daemonHeartbeating.check();
  assert.equal(r.ok, true);
});

// --- explain markdown ---

test('all stage-4 invariants emit non-empty explain markdown', () => {
  for (const inv of [runtimeHooksSettingsPresent, runtimeNodeVersionPinned, daemonHeartbeating]) {
    const md = inv.explain();
    assert.ok(typeof md === 'string' && md.includes(inv.name), `${inv.name}.explain shape`);
  }
});
