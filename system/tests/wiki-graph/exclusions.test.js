import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExcludedPath, EXCLUDED_PATHS } from '../../scripts/lib/wiki-graph/exclusions.js';

test('isExcludedPath: top-level operational files are excluded', () => {
  for (const p of ['inbox.md', 'journal.md', 'log.md', 'decisions.md', 'tasks.md', 'hot.md', 'LINKS.md', 'INDEX.md']) {
    assert.equal(isExcludedPath(p), true, `expected ${p} excluded`);
  }
});

test('isExcludedPath: archive/quarantine/self-improvement subtrees excluded', () => {
  assert.equal(isExcludedPath('archive/anything.md'), true);
  assert.equal(isExcludedPath('quarantine/captures.md'), true);
  assert.equal(isExcludedPath('self-improvement/calibration.md'), true);
});

test('isExcludedPath: knowledge and profile pages NOT excluded', () => {
  assert.equal(isExcludedPath('knowledge/medical/hemonc-lee.md'), false);
  assert.equal(isExcludedPath('profile/identity.md'), false);
});

test('EXCLUDED_PATHS exposes the constant for orchestrator use', () => {
  assert.ok(Array.isArray(EXCLUDED_PATHS));
  assert.ok(EXCLUDED_PATHS.includes('inbox.md'));
});
