import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const FIXTURES = join(REPO_ROOT, 'system/tests/fixtures');
const E2E = join(REPO_ROOT, 'system/tests/e2e');

function listLeafFixtureDirs(root) {
  const out = [];
  if (!existsSync(root)) return out;
  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    const subdirs = entries.filter((e) => e.isDirectory());
    if (subdirs.some((d) => d.name === 'input' || d.name === 'expected')) {
      out.push(dir);
      return;
    }
    for (const d of subdirs) walk(join(dir, d.name));
  }
  walk(root);
  return out;
}

function listE2eTests(root) {
  const out = [];
  if (!existsSync(root)) return out;
  function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.test.js')) out.push(join(dir, e.name));
    }
  }
  walk(root);
  return out;
}

describe('e2e: fixture audit', () => {
  it('every fixture dir is referenced by a .test.js', () => {
    const fixtures = listLeafFixtureDirs(FIXTURES);
    const tests = listE2eTests(E2E);
    const allTestSrc = tests.map((p) => readFileSync(p, 'utf8')).join('\n');

    const orphans = [];
    for (const fix of fixtures) {
      const rel = fix.slice(FIXTURES.length + 1); // e.g. "hooks/on-pre-bash-…"
      if (!allTestSrc.includes(`fixture: '${rel}'`) && !allTestSrc.includes(`fixture: "${rel}"`)) {
        orphans.push(rel);
      }
    }
    assert.deepEqual(orphans, [], `Orphan fixture dirs: ${orphans.join(', ')}`);
  });
});
