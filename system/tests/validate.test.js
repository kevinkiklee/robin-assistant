import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInDir } from '../scripts/lib/validate.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

function makeRepo(populated = true) {
  const root = mkdtempSync(join(tmpdir(), 'robin-validate-'));
  // Real git repo with user-data/ gitignored, matching v3 workspace shape.
  execSync('git init -q', { cwd: root });
  writeFileSync(join(root, '.gitignore'), '/user-data/\n/artifacts/\n/backup/\n');
  mkdirSync(join(root, 'system'));
  mkdirSync(join(root, 'system/scaffold'));
  if (populated) {
    mkdirSync(join(root, 'user-data/memory/profile'), { recursive: true });
    mkdirSync(join(root, 'user-data/state/locks'), { recursive: true });
    writeFileSync(join(root, 'user-data/robin.config.json'),
      JSON.stringify({ version: '3.0.0', user: { name: 'T', timezone: 'UTC' }, platform: 'claude-code' }));
    writeFileSync(join(root, 'user-data/memory/INDEX.md'), '# Memory Index\n');
    writeFileSync(join(root, 'user-data/memory/profile/identity.md'),
      '---\ndescription: Identity\n---\n# Identity\n');
    for (const f of ['tasks.md','decisions.md','journal.md','inbox.md','self-improvement.md']) {
      writeFileSync(join(root, 'user-data/memory', f), '# stub\n');
    }
    writeFileSync(join(root, 'user-data/integrations.md'), '# stub\n');
    writeFileSync(join(root, 'user-data/state/sessions.md'), '');
    writeFileSync(join(root, 'user-data/state/dream-state.md'), '');
  }
  return root;
}

test('validate passes on a fully populated v3 workspace', async () => {
  const root = makeRepo(true);
  const result = await validateInDir(root);
  assert.equal(result.issues, 0);
  rmSync(root, { recursive: true, force: true });
});

test('validate fails when user-data/ is missing', async () => {
  const root = makeRepo(false);
  const result = await validateInDir(root);
  assert.ok(result.issues > 0);
  rmSync(root, { recursive: true, force: true });
});
