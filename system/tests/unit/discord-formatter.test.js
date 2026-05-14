import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatForDiscord,
  originForTarget,
  splitMessage,
  stripMention,
  tablesToCodeBlocks,
  threadTitleFrom,
} from '../../io/integrations/discord/formatter.js';

test('stripMention removes leading <@id> and trims', () => {
  assert.equal(stripMention('<@123> hello', '123'), 'hello');
  assert.equal(stripMention('<@!123>   hello   ', '123'), 'hello');
  assert.equal(stripMention('hello', '123'), 'hello');
  assert.equal(stripMention('', '123'), '');
  // Mention in the middle is NOT stripped (only leading).
  assert.equal(stripMention('hello <@123>', '123'), 'hello <@123>');
});

test('splitMessage returns [] for empty / whitespace', () => {
  assert.deepEqual(splitMessage(''), []);
  assert.deepEqual(splitMessage('   '), []);
});

test('splitMessage returns single chunk for short text', () => {
  assert.deepEqual(splitMessage('hello'), ['hello']);
});

test('splitMessage chunks text longer than the limit', () => {
  const limit = 100;
  // 350 chars → at least 3 chunks at limit=100
  const text = 'word '.repeat(70).trim();
  const chunks = splitMessage(text, limit);
  assert.ok(chunks.length >= 3, `expected ≥3 chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.length <= limit + 4, `chunk too long: ${c.length}`); // +4 for closing-fence reserve
  }
});

test('splitMessage keeps code fences balanced across chunks', () => {
  // Long code block that must split: assert each chunk has even number of ```
  const code = '\n'.padEnd(150, 'a');
  const text = `prose paragraph one.\n\n\`\`\`js\n${code}\n${code}\n${code}\n\`\`\`\n\nprose paragraph two.`;
  const chunks = splitMessage(text, 120);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    const fenceCount = (c.match(/```/g) || []).length;
    assert.equal(fenceCount % 2, 0, `chunk has unbalanced fences:\n${c}`);
  }
});

test('threadTitleFrom strips mention and clips to max code points', () => {
  assert.equal(threadTitleFrom('<@123> hello there', '123'), 'hello there');
  assert.equal(threadTitleFrom('', '123'), 'Robin');
  assert.equal(threadTitleFrom('<@123>', '123'), 'Robin');
  const long = '<@123> ' + 'a'.repeat(200);
  assert.equal(threadTitleFrom(long, '123', 50).length, 50);
});

test('threadTitleFrom does not split surrogate pairs', () => {
  // Each 🐦 is 2 UTF-16 code units but 1 code point.
  const birds = '🐦'.repeat(60);
  const title = threadTitleFrom(birds, '123', 50);
  // 50 code points = 100 UTF-16 code units of '🐦' surrogates.
  assert.equal([...title].length, 50);
});

test('originForTarget: guild channel', () => {
  const target = { id: 'C1', guildId: 'G1' };
  assert.equal(originForTarget(target, 'U1'), 'discord:guild:G1:channel:C1');
});

test('originForTarget: thread', () => {
  const target = {
    id: 'T1',
    guildId: 'G1',
    parentId: 'C1',
    isThread: () => true,
  };
  assert.equal(originForTarget(target, 'U1'), 'discord:guild:G1:channel:C1:thread:T1');
});

test('originForTarget: DM via recipient', () => {
  const target = { id: 'D1', recipient: { id: 'U1' } };
  assert.equal(originForTarget(target, null), 'discord:dm:U1');
});

test('originForTarget: DM falls back to userId arg when recipient missing', () => {
  const target = { id: 'D1' };
  assert.equal(originForTarget(target, 'U1'), 'discord:dm:U1');
});

test('originForTarget: null when target is unrecognizable', () => {
  assert.equal(originForTarget(null, 'U1'), null);
  assert.equal(originForTarget({}, null), null);
});

test('tablesToCodeBlocks: leaves text unchanged when no table present', () => {
  assert.equal(tablesToCodeBlocks(''), '');
  assert.equal(tablesToCodeBlocks(null), '');
  assert.equal(tablesToCodeBlocks('hello\nworld'), 'hello\nworld');
  // Has pipes but no separator row → not a table.
  assert.equal(tablesToCodeBlocks('a | b | c'), 'a | b | c');
});

test('tablesToCodeBlocks: converts GFM table to fenced code block with padded columns', () => {
  const input = [
    '| Date | Flight | Route |',
    '|---|---|---|',
    '| Thu 5/14 | AA 2915 | JFK → SNA |',
    '| Fri 5/22 | AA 166 | SFO → JFK |',
  ].join('\n');
  const out = tablesToCodeBlocks(input);
  assert.ok(out.startsWith('```\n'), `expected opening fence:\n${out}`);
  assert.ok(out.endsWith('\n```'), `expected closing fence:\n${out}`);
  const body = out.slice(4, -4); // strip fences
  const lines = body.split('\n');
  assert.equal(lines.length, 3, `expected header + 2 rows, got: ${lines.length}`);
  // No leftover pipes or `---` separator inside the code block.
  for (const line of lines) {
    assert.equal(line.includes('|'), false, `leftover pipe in: ${line}`);
    assert.equal(line.startsWith('---'), false, `leftover separator: ${line}`);
  }
  // Header column "Date" should be left-aligned and padded to "Thu 5/14" width.
  assert.ok(lines[0].startsWith('Date'), `header: ${lines[0]}`);
  assert.ok(lines[1].startsWith('Thu 5/14'), `row 1: ${lines[1]}`);
  // Columns are space-separated; flight column should align (header and rows
  // share the column start index).
  const flightCol = lines[0].indexOf('Flight');
  assert.ok(flightCol > 0);
  assert.equal(lines[1].slice(flightCol).startsWith('AA 2915'), true);
  assert.equal(lines[2].slice(flightCol).startsWith('AA 166'), true);
});

test('tablesToCodeBlocks: strips bold/italic/inline-code wrappers inside cells', () => {
  const input = [
    '| Day | Flight |',
    '|---|---|',
    '| Thu 5/14 | **AA 2915** |',
    '| Fri 5/22 | __AA 166__ |',
  ].join('\n');
  const out = tablesToCodeBlocks(input);
  assert.equal(out.includes('**'), false, `bold leaked into output:\n${out}`);
  assert.equal(out.includes('__'), false, `italic leaked into output:\n${out}`);
  assert.ok(out.includes('AA 2915'));
  assert.ok(out.includes('AA 166'));
});

test('tablesToCodeBlocks: preserves prose around the table', () => {
  const input = [
    '✈️ **Flights**',
    '',
    '| Date | Flight |',
    '|---|---|',
    '| Thu 5/14 | AA 2915 |',
    '',
    '🏨 **Lodging**',
  ].join('\n');
  const out = tablesToCodeBlocks(input);
  assert.ok(out.startsWith('✈️ **Flights**\n\n```'), `prose before table lost:\n${out}`);
  assert.ok(out.endsWith('```\n\n🏨 **Lodging**'), `prose after table lost:\n${out}`);
});

test('tablesToCodeBlocks: handles multiple tables independently', () => {
  const input = [
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    'middle prose',
    '',
    '| C | D |',
    '|---|---|',
    '| 3 | 4 |',
  ].join('\n');
  const out = tablesToCodeBlocks(input);
  const fenceCount = (out.match(/```/g) || []).length;
  assert.equal(fenceCount, 4, `expected 4 fences (2 tables × open+close), got: ${fenceCount}`);
  assert.ok(out.includes('middle prose'));
});

test('tablesToCodeBlocks: does not touch tables already inside a code fence', () => {
  const input = ['```', '| A | B |', '|---|---|', '| 1 | 2 |', '```'].join('\n');
  // Input is a code fence containing a table-shaped string. Should pass through
  // untouched.
  assert.equal(tablesToCodeBlocks(input), input);
});

test('formatForDiscord: thin wrapper that runs the table transform', () => {
  const input = '| A | B |\n|---|---|\n| 1 | 2 |';
  const out = formatForDiscord(input);
  assert.ok(out.startsWith('```\n'));
  assert.ok(out.endsWith('\n```'));
  assert.equal(out.includes('|---|'), false);
});
