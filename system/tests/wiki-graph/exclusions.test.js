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

import { computeSkipRanges, isInsideSkipRange } from '../../scripts/lib/wiki-graph/exclusions.js';

test('computeSkipRanges: YAML frontmatter is a skip range', () => {
  const body = '---\ntitle: x\n---\nHello world';
  const ranges = computeSkipRanges(body);
  assert.ok(ranges.some(([s, e]) => s === 0 && e === '---\ntitle: x\n---'.length));
});

test('computeSkipRanges: fenced code blocks (``` and ~~~) are skip ranges', () => {
  const body = 'Plain\n```js\ncode here\n```\nMore plain';
  const ranges = computeSkipRanges(body);
  const codeStart = body.indexOf('```');
  const codeEnd = body.indexOf('```', codeStart + 3) + 3;
  assert.ok(ranges.some(([s, e]) => s === codeStart && e === codeEnd));
});

test('computeSkipRanges: inline code is a skip range', () => {
  const body = 'Use the `Lee` reference';
  const ranges = computeSkipRanges(body);
  const tickStart = body.indexOf('`');
  assert.ok(ranges.some(([s, e]) => s === tickStart && e === tickStart + 5));
});

test('computeSkipRanges: markdown link [text](url) is a skip range over the whole construct', () => {
  const body = 'See [Dr. Lee](path.md) for details';
  const ranges = computeSkipRanges(body);
  const linkStart = body.indexOf('[Dr. Lee]');
  const linkEnd = body.indexOf(')') + 1;
  assert.ok(ranges.some(([s, e]) => s === linkStart && e === linkEnd));
});

test('computeSkipRanges: bare URL is a skip range', () => {
  const body = 'Visit https://example.com/Lee for info';
  const ranges = computeSkipRanges(body);
  const urlStart = body.indexOf('https://');
  assert.ok(ranges.some(([s, e]) => s === urlStart && e === urlStart + 'https://example.com/Lee'.length));
});

test('isInsideSkipRange: returns true when offset falls inside any range', () => {
  const ranges = [[0, 10], [20, 30]];
  assert.equal(isInsideSkipRange(5, ranges), true);
  assert.equal(isInsideSkipRange(25, ranges), true);
  assert.equal(isInsideSkipRange(15, ranges), false);
  assert.equal(isInsideSkipRange(30, ranges), false); // half-open: end exclusive
});
