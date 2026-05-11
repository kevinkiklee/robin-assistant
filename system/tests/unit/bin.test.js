import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { resolveBinPath } from '../../runtime/cli/bin.js';

test('resolveBinPath returns an absolute path that exists', () => {
  const p = resolveBinPath();
  assert.equal(typeof p, 'string');
  assert.ok(p.startsWith('/'));
  assert.ok(existsSync(p), `expected ${p} to exist`);
});

test('resolveBinPath returns the bin/robin entry point', () => {
  const p = resolveBinPath();
  assert.match(p, /\/bin\/robin$/);
  const stats = statSync(p);
  assert.ok(stats.mode & 0o111, 'expected file to be executable');
});
