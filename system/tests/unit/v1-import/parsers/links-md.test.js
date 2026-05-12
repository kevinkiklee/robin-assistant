import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLinksMd } from '../../../../runtime/install/v1-import/parsers/links-md.js';

test('parseLinksMd: parses rows after the header', () => {
  const src = [
    '| From | To | Context |',
    '|------|----|---------|',
    '| knowledge/a.md | knowledge/b.md | some context |',
    '| knowledge/c.md | profile/people/jake-lee.md | Joony |',
  ].join('\n');
  const rows = parseLinksMd(src);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    from_path: 'knowledge/a.md',
    to_path: 'knowledge/b.md',
    context: 'some context',
  });
  assert.equal(rows[1].to_path, 'profile/people/jake-lee.md');
  assert.equal(rows[1].context, 'Joony');
});

test('parseLinksMd: skips header and separator rows automatically', () => {
  // `From`/`To` are plain text, not pathish — should be filtered.
  const src = ['| From | To | Context |', '|------|----|---------|'].join('\n');
  assert.deepEqual(parseLinksMd(src), []);
});

test('parseLinksMd: accepts empty context cell', () => {
  const src = '| knowledge/x.md | knowledge/y.md |  |';
  const rows = parseLinksMd(src);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].context, '');
});

test('parseLinksMd: drops rows where either endpoint is not pathish', () => {
  const src = ['| knowledge/a.md | something | ctx |', '| not-a-path | knowledge/b.md | ctx |'].join('\n');
  assert.deepEqual(parseLinksMd(src), []);
});

test('parseLinksMd: returns empty array on non-string input', () => {
  assert.deepEqual(parseLinksMd(null), []);
});
