// Guard test for the workspaceDir resolution convention in scaffolded scripts.
//
// system/scaffold/runtime/scripts/ contains the source-of-truth templates that
// postinstall copies (with `force: true`) into user-data/runtime/scripts/. If a
// script computes its workspaceDir incorrectly here, every install reintroduces
// the bug — even after the user-data copy has been hand-fixed.
//
// The original failure mode this guards against: `fileURLToPath(new URL('../..',
// import.meta.url))`. For a script at `<root>/user-data/runtime/scripts/<x>.js`,
// `../..` resolves only to `<root>/user-data/`, not the package root. Every
// downstream `join(workspaceDir, 'user-data/...')` then doubles up to
// `user-data/user-data/...`, leaving a parallel state tree that nothing else
// reads. The fix is to use `resolveWorkspaceDir(import.meta.url)` from
// `system/scripts/lib/workspace-root.js`, which walks up looking for
// `bin/robin.js` and validates `ROBIN_WORKSPACE` if set.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCAFFOLD_SCRIPTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../scaffold/runtime/scripts'
);

const BUGGY_PATTERN = /fileURLToPath\s*\(\s*new\s+URL\s*\(\s*['"]\.\.\/\.\.['"]/;
const SAFE_PATTERN = /resolveWorkspaceDir\s*\(\s*import\.meta\.url\s*\)/;

function listScaffoldScripts() {
  return readdirSync(SCAFFOLD_SCRIPTS_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, path: join(SCAFFOLD_SCRIPTS_DIR, name) }));
}

test('scaffold scripts: no file uses the buggy fileURLToPath(new URL("../..", import.meta.url)) pattern', () => {
  const offenders = [];
  for (const { name, path } of listScaffoldScripts()) {
    const src = readFileSync(path, 'utf-8');
    if (BUGGY_PATTERN.test(src)) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `scaffold scripts using the buggy '../..' workspace resolver (causes user-data/user-data/ doubling): ${offenders.join(', ')}. ` +
      `Replace with: import { resolveWorkspaceDir } from '../../../system/scripts/lib/workspace-root.js'; const workspaceDir = resolveWorkspaceDir(import.meta.url);`
  );
});

test('scaffold scripts: any file declaring workspaceDir from import.meta.url uses resolveWorkspaceDir', () => {
  const offenders = [];
  for (const { name, path } of listScaffoldScripts()) {
    const src = readFileSync(path, 'utf-8');
    // Only flag files that derive workspaceDir from import.meta.url somehow.
    if (!/workspaceDir\s*=.*import\.meta\.url/.test(src)) continue;
    if (!SAFE_PATTERN.test(src)) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `scaffold scripts derive workspaceDir from import.meta.url without resolveWorkspaceDir: ${offenders.join(', ')}`
  );
});
