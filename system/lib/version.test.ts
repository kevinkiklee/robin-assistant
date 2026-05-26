import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { VERSION } from './version.ts';

test('VERSION matches package.json version', () => {
  const pkgPath = join(import.meta.dirname ?? process.cwd(), '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  assert.equal(VERSION, pkg.version, 'VERSION constant must match package.json');
});

test('VERSION is a valid semver-ish string', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});
