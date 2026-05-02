import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findStalePaths } from '../../scripts/diagnostics/check-doc-paths.js';

test('flags reference to a system path that does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-'));
  mkdirSync(join(dir, 'system/scripts/cli'), { recursive: true });
  writeFileSync(join(dir, 'system/scripts/cli/setup.js'), '// real');
  writeFileSync(join(dir, 'AGENTS.md'), [
    '`system/scripts/cli/setup.js` exists.',
    '`system/scripts/cli/missing.js` does not exist.',
  ].join('\n'));

  const issues = findStalePaths(dir);
  assert.equal(issues.length, 1);
  assert.match(issues[0].path, /missing\.js/);
});

test('reports zero issues when all paths exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-ok-'));
  mkdirSync(join(dir, 'system/scripts/cli'), { recursive: true });
  writeFileSync(join(dir, 'system/scripts/cli/setup.js'), '// real');
  writeFileSync(join(dir, 'system/scripts/cli/init.js'), '// real');
  writeFileSync(join(dir, 'AGENTS.md'), [
    '`system/scripts/cli/setup.js` and `system/scripts/cli/init.js` are both real.',
  ].join('\n'));

  const issues = findStalePaths(dir);
  assert.equal(issues.length, 0);
});

test('ignores paths under docs/superpowers and CHANGELOG.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-skip-'));
  mkdirSync(join(dir, 'docs/superpowers/specs'), { recursive: true });
  mkdirSync(join(dir, 'system'), { recursive: true });
  writeFileSync(
    join(dir, 'docs/superpowers/specs/spec.md'),
    '`system/old-path-that-no-longer-exists.md`'
  );
  writeFileSync(join(dir, 'CHANGELOG.md'), '`system/another-old.md`');

  const issues = findStalePaths(dir);
  assert.equal(issues.length, 0);
});

test('skips system/migrations/ directory (immutable history)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-mig-'));
  mkdirSync(join(dir, 'system/migrations'), { recursive: true });
  writeFileSync(
    join(dir, 'system/migrations/0001-baseline.js'),
    '// references `system/long-gone.md` in a comment'
  );
  // .md file in migrations folder
  writeFileSync(
    join(dir, 'system/migrations/CONTRIBUTING.md'),
    '`system/long-gone.md` should not be flagged because migrations are immutable history.'
  );

  const issues = findStalePaths(dir);
  assert.equal(issues.length, 0);
});

test('only scans .md files (not .js, .json, etc.)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-md-'));
  mkdirSync(join(dir, 'system'), { recursive: true });
  writeFileSync(
    join(dir, 'some.js'),
    "// `system/missing.md` in JS comment shouldn't be flagged"
  );
  writeFileSync(
    join(dir, 'config.json'),
    '{"path": "system/missing.md"}'
  );

  const issues = findStalePaths(dir);
  assert.equal(issues.length, 0);
});

test('skips node_modules and .git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-skip2-'));
  mkdirSync(join(dir, 'node_modules/some-pkg'), { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules/some-pkg/README.md'),
    '`system/missing.md`'
  );
  writeFileSync(join(dir, '.git/HEAD.md'), '`system/missing.md`');

  const issues = findStalePaths(dir);
  assert.equal(issues.length, 0);
});
