import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveUserDataDir } from '../../lib/paths.ts';

// The repo is public. Every TRACKED file must be free of the operator's personal
// data: profile terms (user-data/config/operator.yaml), the people/medications/
// accounts in Robin's memory, and personal shapes (phones, mailboxes, last-4s).
// Same scanner the pre-commit and pre-push hooks run (system/scripts/private-scan.mjs).
// No profile and no memory (CI, a fresh clone) → nothing to compare against → skip.

function hasOperatorData(): boolean {
  try {
    const ud = resolveUserDataDir();
    return (
      existsSync(join(ud, 'config', 'operator.yaml')) ||
      existsSync(join(ud, 'state', 'db', 'robin.sqlite'))
    );
  } catch {
    return false;
  }
}

test('privacy: no tracked file contains the operator’s personal data', {
  skip: !hasOperatorData() && 'no operator profile or memory on this machine',
}, () => {
  const r = spawnSync('node', ['system/scripts/private-scan.mjs', '--tracked'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
});
