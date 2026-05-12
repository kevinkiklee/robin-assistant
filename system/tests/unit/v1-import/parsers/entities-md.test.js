import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEntitiesMd } from '../../../../runtime/install/v1-import/parsers/entities-md.js';

test('parseEntitiesMd: extracts canonical, aliases, and source path', () => {
  const src = [
    '# Entities',
    '',
    '- B&H Photo — NYC SuperStore (B&H, B&H Photo, B&H Photo Video, BH Photo) — knowledge/service-providers/bh-photo.md',
    '- Anthropic (Anthropic) — knowledge/service-providers/anthropic.md',
  ].join('\n');
  const rows = parseEntitiesMd(src);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].canonical_name, 'B&H Photo — NYC SuperStore');
  assert.deepEqual(rows[0].aliases, ['B&H', 'B&H Photo', 'B&H Photo Video', 'BH Photo']);
  assert.equal(rows[0].source_path, 'knowledge/service-providers/bh-photo.md');
  assert.equal(rows[1].canonical_name, 'Anthropic');
  // The canonical-name-as-only-alias should be deduped out.
  assert.deepEqual(rows[1].aliases, []);
});

test('parseEntitiesMd: skips header/comment/empty lines', () => {
  const src = [
    '# Entities',
    '',
    '<!-- DO NOT EDIT -->',
    '',
    '- Alpha (alpha) — knowledge/a.md',
  ].join('\n');
  const rows = parseEntitiesMd(src);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].canonical_name, 'Alpha');
});

test('parseEntitiesMd: dedupes aliases preserving order', () => {
  const src = '- X (a, b, a, c, b) — knowledge/x.md';
  const rows = parseEntitiesMd(src);
  assert.deepEqual(rows[0].aliases, ['a', 'b', 'c']);
});

test('parseEntitiesMd: handles empty alias parenthetical', () => {
  const src = '- Y () — knowledge/y.md';
  const rows = parseEntitiesMd(src);
  assert.deepEqual(rows[0].aliases, []);
});

test('parseEntitiesMd: returns empty array on non-string input', () => {
  assert.deepEqual(parseEntitiesMd(null), []);
  assert.deepEqual(parseEntitiesMd(undefined), []);
});
