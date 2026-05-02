import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveWorkspaceDir,
  resolveCliWorkspaceDir,
  validateWorkspaceRoot,
} from '../../scripts/lib/workspace-root.js';

function makeFakeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'workspace-root-'));
  mkdirSync(join(ws, 'bin'), { recursive: true });
  writeFileSync(join(ws, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(ws, 'user-data/runtime/state/sync'), { recursive: true });
  return ws;
}

function withEnv(overrides, cwd, fn) {
  const origEnv = { ...process.env };
  const origCwd = process.cwd();
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (cwd) process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(origCwd);
    for (const k of Object.keys(overrides)) delete process.env[k];
    Object.assign(process.env, origEnv);
  }
}

test('validateWorkspaceRoot: accepts the package root', () => {
  const ws = makeFakeWorkspace();
  try {
    assert.equal(validateWorkspaceRoot(ws, 'test'), ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('validateWorkspaceRoot: rejects user-data/ with helpful error pointing to root', () => {
  const ws = makeFakeWorkspace();
  try {
    const userData = join(ws, 'user-data');
    assert.throws(
      () => validateWorkspaceRoot(userData, 'TEST_SOURCE'),
      (err) => {
        assert.match(err.message, /TEST_SOURCE/);
        assert.match(err.message, /not a robin workspace root/);
        assert.ok(err.message.includes(ws), `expected error to mention root ${ws}, got: ${err.message}`);
        return true;
      }
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('validateWorkspaceRoot: rejects a path outside any workspace', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'no-workspace-'));
  try {
    assert.throws(
      () => validateWorkspaceRoot(tmp, 'TEST_SOURCE'),
      /not inside a robin workspace/
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveCliWorkspaceDir: uses ROBIN_WORKSPACE when set and valid', () => {
  const ws = makeFakeWorkspace();
  try {
    withEnv({ ROBIN_WORKSPACE: ws }, null, () => {
      assert.equal(resolveCliWorkspaceDir(), ws);
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveCliWorkspaceDir: throws when ROBIN_WORKSPACE points inside user-data/', () => {
  const ws = makeFakeWorkspace();
  try {
    withEnv({ ROBIN_WORKSPACE: join(ws, 'user-data') }, null, () => {
      assert.throws(() => resolveCliWorkspaceDir(), /ROBIN_WORKSPACE.*not a robin workspace root/);
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveCliWorkspaceDir: falls back to cwd and validates it', () => {
  const ws = makeFakeWorkspace();
  // process.cwd() returns realpath on macOS, so /var/... becomes /private/var/...
  const wsReal = realpathSync(ws);
  try {
    withEnv({ ROBIN_WORKSPACE: undefined }, ws, () => {
      assert.equal(resolveCliWorkspaceDir(), wsReal);
    });
    withEnv({ ROBIN_WORKSPACE: undefined }, join(ws, 'user-data'), () => {
      assert.throws(() => resolveCliWorkspaceDir(), /process\.cwd\(\).*not a robin workspace root/);
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveWorkspaceDir: validates ROBIN_WORKSPACE if set', () => {
  const ws = makeFakeWorkspace();
  try {
    withEnv({ ROBIN_WORKSPACE: join(ws, 'user-data') }, null, () => {
      assert.throws(
        () => resolveWorkspaceDir(`file://${join(ws, 'user-data/runtime/scripts/x.js')}`),
        /ROBIN_WORKSPACE.*not a robin workspace root/
      );
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveWorkspaceDir: marker walk finds package root from a deeply nested script', () => {
  const ws = makeFakeWorkspace();
  try {
    withEnv({ ROBIN_WORKSPACE: undefined }, null, () => {
      const fakeScript = `file://${join(ws, 'user-data/runtime/scripts/lib/lunch-money/client.js')}`;
      assert.equal(resolveWorkspaceDir(fakeScript), ws);
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
