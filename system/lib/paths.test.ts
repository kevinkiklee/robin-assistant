import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  resolveConfigDir,
  resolveUserDataDir,
  userDataPointerPath,
  writeUserDataPointer,
} from './paths.ts';

test('paths: ROBIN_USER_DATA_DIR overrides everything', () => {
  const dir = resolveUserDataDir({
    env: { ROBIN_USER_DATA_DIR: '/tmp/custom-robin' },
    home: '/Users/x',
  });
  assert.equal(dir, '/tmp/custom-robin');
});

test('paths: falls back to XDG_DATA_HOME when no env override', () => {
  const dir = resolveUserDataDir({
    env: { XDG_DATA_HOME: '/Users/x/.local/share' },
    home: '/Users/x',
  });
  assert.equal(dir, '/Users/x/.local/share/robin');
});

test('paths: falls back to ~/.local/share/robin when XDG_DATA_HOME unset', () => {
  const dir = resolveUserDataDir({ env: {}, home: '/Users/x' });
  assert.equal(dir, '/Users/x/.local/share/robin');
});

test('paths: config dir uses XDG_CONFIG_HOME', () => {
  const dir = resolveConfigDir({ env: { XDG_CONFIG_HOME: '/Users/x/.config' }, home: '/Users/x' });
  assert.equal(dir, '/Users/x/.config/robin');
});

test('paths: config dir falls back to ~/.config/robin', () => {
  const dir = resolveConfigDir({ env: {}, home: '/Users/x' });
  assert.equal(dir, '/Users/x/.config/robin');
});

test('paths: pointer file path lives under the config dir', () => {
  const p = userDataPointerPath({ env: { XDG_CONFIG_HOME: '/Users/x/.config' }, home: '/Users/x' });
  assert.equal(p, '/Users/x/.config/robin/user-data-dir');
});

test('paths: pointer file is used when env override is absent', () => {
  const xdgConfig = mkdtempSync(join(tmpdir(), 'robin-cfg-'));
  try {
    const opts = { env: { XDG_CONFIG_HOME: xdgConfig }, home: '/Users/x' };
    const written = writeUserDataPointer('/srv/robin-instance', opts);
    assert.equal(written, join(xdgConfig, 'robin', 'user-data-dir'));
    // pointer beats the XDG default
    assert.equal(resolveUserDataDir(opts), '/srv/robin-instance');
  } finally {
    rmSync(xdgConfig, { recursive: true, force: true });
  }
});

test('paths: env override beats the pointer file', () => {
  const xdgConfig = mkdtempSync(join(tmpdir(), 'robin-cfg-'));
  try {
    const base = { env: { XDG_CONFIG_HOME: xdgConfig }, home: '/Users/x' };
    writeUserDataPointer('/srv/robin-instance', base);
    const dir = resolveUserDataDir({
      env: { XDG_CONFIG_HOME: xdgConfig, ROBIN_USER_DATA_DIR: '/tmp/env-wins' },
      home: '/Users/x',
    });
    assert.equal(dir, '/tmp/env-wins');
  } finally {
    rmSync(xdgConfig, { recursive: true, force: true });
  }
});

test('paths: resolution order is env > pointer > XDG default', () => {
  const xdgConfig = mkdtempSync(join(tmpdir(), 'robin-cfg-'));
  try {
    const opts = {
      env: { XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: '/Users/x/.local/share' },
      home: '/Users/x',
    };
    // No pointer yet → XDG default
    assert.equal(resolveUserDataDir(opts), '/Users/x/.local/share/robin');
    // Write pointer → pointer wins over XDG
    writeUserDataPointer('/srv/robin-instance', opts);
    assert.equal(resolveUserDataDir(opts), '/srv/robin-instance');
  } finally {
    rmSync(xdgConfig, { recursive: true, force: true });
  }
});

test('paths: empty / whitespace pointer file is ignored', () => {
  const xdgConfig = mkdtempSync(join(tmpdir(), 'robin-cfg-'));
  try {
    const opts = { env: { XDG_CONFIG_HOME: xdgConfig }, home: '/Users/x' };
    // create the config dir + pointer dir, then write whitespace
    writeUserDataPointer('/srv/robin-instance', opts);
    writeFileSync(userDataPointerPath(opts), '   \n');
    assert.equal(resolveUserDataDir(opts), '/Users/x/.local/share/robin');
  } finally {
    rmSync(xdgConfig, { recursive: true, force: true });
  }
});

test('paths: pointer file contents are trimmed', () => {
  const xdgConfig = mkdtempSync(join(tmpdir(), 'robin-cfg-'));
  try {
    const opts = { env: { XDG_CONFIG_HOME: xdgConfig }, home: '/Users/x' };
    const p = writeUserDataPointer('/srv/robin-instance', opts);
    // writer appends a trailing newline; reader must strip it
    assert.equal(readFileSync(p, 'utf8'), '/srv/robin-instance\n');
    assert.equal(resolveUserDataDir(opts), '/srv/robin-instance');
  } finally {
    rmSync(xdgConfig, { recursive: true, force: true });
  }
});

test('paths: writeUserDataPointer creates the config dir if missing', () => {
  const xdgConfig = mkdtempSync(join(tmpdir(), 'robin-cfg-'));
  try {
    // nested, non-existent config home → writer must mkdir -p
    const opts = { env: { XDG_CONFIG_HOME: join(xdgConfig, 'nested', 'deep') }, home: '/Users/x' };
    const p = writeUserDataPointer('/srv/robin-instance', opts);
    assert.equal(readFileSync(p, 'utf8').trim(), '/srv/robin-instance');
  } finally {
    rmSync(xdgConfig, { recursive: true, force: true });
  }
});

test('paths: writeUserDataPointer rejects relative paths', () => {
  const xdgConfig = mkdtempSync(join(tmpdir(), 'robin-cfg-'));
  try {
    const opts = { env: { XDG_CONFIG_HOME: xdgConfig }, home: '/Users/x' };
    assert.throws(() => writeUserDataPointer('relative/path', opts), /must be absolute/);
  } finally {
    rmSync(xdgConfig, { recursive: true, force: true });
  }
});
