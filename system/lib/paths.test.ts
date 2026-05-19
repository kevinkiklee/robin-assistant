import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfigDir, resolveUserDataDir } from './paths.ts';

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
