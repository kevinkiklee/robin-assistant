import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isInSync,
  renderRunbook,
  replaceSentinelBlock,
  SENTINEL_BEGIN,
  SENTINEL_END,
} from '../../../runtime/invariants/runbook.js';
import { makeFakeInvariant } from '../../helpers/invariant-fixtures.js';

test('renderRunbook produces markdown for each invariant', () => {
  const invs = [
    makeFakeInvariant({ name: 'paths.a', phase: 'paths' }),
    makeFakeInvariant({ name: 'db.b', phase: 'db' }),
    makeFakeInvariant({ name: 'runtime.c', phase: 'runtime' }),
  ];
  const md = renderRunbook(invs);
  assert.ok(md.includes('## Operational invariants'));
  assert.ok(md.includes('paths.a'));
  assert.ok(md.includes('db.b'));
  assert.ok(md.includes('runtime.c'));
  // Phase ordering: paths comes before db, db before runtime
  const aIdx = md.indexOf('paths.a');
  const bIdx = md.indexOf('db.b');
  const cIdx = md.indexOf('runtime.c');
  assert.ok(aIdx < bIdx && bIdx < cIdx, 'phase ordering preserved');
});

test('renderRunbook skips empty phases', () => {
  const invs = [makeFakeInvariant({ name: 'paths.a', phase: 'paths' })];
  const md = renderRunbook(invs);
  assert.ok(!md.includes('### Database'));
  assert.ok(md.includes('### Paths'));
});

test('replaceSentinelBlock replaces existing block in-place', () => {
  const before = `# Title\n\nSome content.\n\n${SENTINEL_BEGIN}\nold runbook\n${SENTINEL_END}\n\nMore content.\n`;
  const out = replaceSentinelBlock(before, 'new runbook body');
  assert.ok(out.includes('new runbook body'));
  assert.ok(!out.includes('old runbook'));
  assert.ok(out.includes('Some content.'));
  assert.ok(out.includes('More content.'));
});

test('replaceSentinelBlock appends when sentinels missing', () => {
  const before = '# Title\n\nNo sentinels here.\n';
  const out = replaceSentinelBlock(before, 'new body');
  assert.ok(out.includes('# Title'));
  assert.ok(out.includes(SENTINEL_BEGIN));
  assert.ok(out.includes('new body'));
  assert.ok(out.includes(SENTINEL_END));
});

test('isInSync returns true when block matches', () => {
  const body = 'identical body';
  const file = `prefix\n${SENTINEL_BEGIN}\n\n${body}\n\n${SENTINEL_END}\nsuffix`;
  assert.equal(isInSync(file, body), true);
});

test('isInSync returns false when block differs', () => {
  const file = `prefix\n${SENTINEL_BEGIN}\nold\n${SENTINEL_END}\nsuffix`;
  assert.equal(isInSync(file, 'new'), false);
});

test('isInSync returns false when sentinels absent', () => {
  assert.equal(isInSync('no sentinels', 'body'), false);
});
