import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const FIXTURES = join(REPO_ROOT, 'system/tests/fixtures');
const TESTS = join(REPO_ROOT, 'system/tests');

function listLeafScenarioFixtureDirs(root) {
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

function listAllTests(root) {
  const out = [];
  if (!existsSync(root)) return out;
  function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === 'fixtures') continue;
        walk(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith('.test.js')) out.push(join(dir, e.name));
    }
  }
  walk(root);
  return out;
}

describe('lib: fixture audit', () => {
  const tests = listAllTests(TESTS);
  const allTestSrc = tests.map((p) => readFileSync(p, 'utf8')).join('\n');

  it('every scenario-fixture dir (input/expected pair) is referenced by a .test.js', () => {
    const fixtures = listLeafScenarioFixtureDirs(FIXTURES);
    const orphans = [];
    for (const fix of fixtures) {
      const rel = fix.slice(FIXTURES.length + 1); // e.g. "hooks/on-pre-bash-…"
      if (!allTestSrc.includes(`fixture: '${rel}'`) && !allTestSrc.includes(`fixture: "${rel}"`)) {
        orphans.push(rel);
      }
    }
    assert.deepEqual(orphans, [], `Orphan scenario-fixture dirs: ${orphans.join(', ')}`);
  });

  it('every top-level fixtures/ subdir is referenced somewhere in the test tree', () => {
    if (!existsSync(FIXTURES)) return;
    const topLevel = readdirSync(FIXTURES, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    // A top-level dir is in use if any of these reference patterns exists:
    //   - fixture: '<name>/...' or fixture: "<name>/..."  (scenario fixture convention)
    //   - 'fixtures/<name>' or "fixtures/<name>"          (literal path)
    //   - 'fixtures', '<name>' or "fixtures", "<name>"    (path-segment join)
    const orphans = topLevel.filter((name) => {
      const fixtureRefSingle = new RegExp(`fixture:\\s*'${name}/`);
      const fixtureRefDouble = new RegExp(`fixture:\\s*"${name}/`);
      const literalRef = `fixtures/${name}`;
      const segmentRef = new RegExp(`['"]fixtures['"]\\s*,\\s*['"]${name}['"]`);
      return !fixtureRefSingle.test(allTestSrc)
        && !fixtureRefDouble.test(allTestSrc)
        && !allTestSrc.includes(literalRef)
        && !segmentRef.test(allTestSrc);
    });
    assert.deepEqual(orphans, [], `Orphan top-level fixture dirs: ${orphans.join(', ')}`);
  });
});
