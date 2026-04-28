import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkChangelog } from '../core/scripts/lib/changelog-notify.js';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('changelog-notify returns latest entry on first run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-cl-'));
  mkdirSync(join(root, 'core'));
  mkdirSync(join(root, 'user-data'));
  writeFileSync(join(root, 'core/CHANGELOG.md'),
    '## [3.0.1] - 2026-05-01\n\n- Bug fix\n\n## [3.0.0] - 2026-04-27\n\n- Initial v3\n');
  const result = await checkChangelog(root);
  assert.ok(result.notice);
  assert.match(result.notice, /3\.0\.1/);
  rmSync(root, { recursive: true, force: true });
});

test('changelog-notify is silent on second run if unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-cl-'));
  mkdirSync(join(root, 'core'));
  mkdirSync(join(root, 'user-data'));
  writeFileSync(join(root, 'core/CHANGELOG.md'), '## [3.0.0]\n');
  await checkChangelog(root);
  const r2 = await checkChangelog(root);
  assert.equal(r2.notice, null);
  rmSync(root, { recursive: true, force: true });
});
