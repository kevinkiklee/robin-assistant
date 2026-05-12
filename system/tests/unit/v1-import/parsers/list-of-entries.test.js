import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseListOfEntries } from '../../../../runtime/install/v1-import/parsers/list-of-entries.js';

test('parseListOfEntries: H2 sections each become one entry with the section body', () => {
  const src = [
    '# Patterns',
    '',
    '## Pattern A',
    '',
    'Body of A.',
    '',
    '## Pattern B',
    '',
    'Body of B.',
    '- a sub-bullet inside B',
  ].join('\n');
  const rows = parseListOfEntries(src);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Pattern A');
  assert.match(rows[0].content, /Body of A/);
  assert.equal(rows[1].title, 'Pattern B');
  assert.match(rows[1].content, /sub-bullet inside B/);
});

test('parseListOfEntries: top-level bullets each become an entry when no headers exist', () => {
  const src = [
    'Some preamble.',
    '',
    '- First preference',
    '- Second preference',
    '- Third preference',
  ].join('\n');
  const rows = parseListOfEntries(src);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, null);
  assert.equal(rows[0].content, 'First preference');
  assert.equal(rows[2].content, 'Third preference');
});

test('parseListOfEntries: continuation lines fold into the preceding top-level bullet', () => {
  const src = ['- First bullet', '  continued text', '  more continuation', '- Second bullet'].join('\n');
  const rows = parseListOfEntries(src);
  assert.equal(rows.length, 2);
  assert.match(rows[0].content, /continued text[\s\S]+more continuation/);
  assert.equal(rows[1].content, 'Second bullet');
});

test('parseListOfEntries: blank line terminates a bullet', () => {
  const src = '- Alpha\n\n- Beta';
  const rows = parseListOfEntries(src);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content, 'Alpha');
});

test('parseListOfEntries: returns empty for empty input', () => {
  assert.deepEqual(parseListOfEntries(''), []);
  assert.deepEqual(parseListOfEntries('# Just a header'), []);
});
