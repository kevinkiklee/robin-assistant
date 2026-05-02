import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripMention, splitMessage } from '../../../user-data/ops/scripts/lib/discord/formatter.js';

test('stripMention: removes <@id> prefix', () => {
  assert.equal(stripMention('<@123> hello', '123'), 'hello');
});

test('stripMention: removes <@!id> nickname-mention prefix', () => {
  assert.equal(stripMention('<@!123> hello', '123'), 'hello');
});

test('stripMention: handles surrounding whitespace', () => {
  assert.equal(stripMention('  <@123>   hi  ', '123'), 'hi');
});

test('stripMention: passes through messages without mention', () => {
  assert.equal(stripMention('hello there', '123'), 'hello there');
});

test('stripMention: only strips when mention is at start', () => {
  assert.equal(stripMention('hi <@123>', '123'), 'hi <@123>');
});

test('splitMessage: short message returns single chunk', () => {
  const out = splitMessage('hello world');
  assert.deepEqual(out, ['hello world']);
});

test('splitMessage: respects 2000-char Discord limit', () => {
  const big = 'a'.repeat(5000);
  const out = splitMessage(big);
  assert.ok(out.every(c => c.length <= 2000), 'every chunk ≤ 2000 chars');
  assert.equal(out.join(''), big, 'no data lost');
});

test('splitMessage: prefers paragraph breaks over hard cuts', () => {
  const para = ('paragraph.\n\n').repeat(200); // 2200 chars total roughly
  const out = splitMessage(para);
  for (const chunk of out) {
    if (chunk.length > 100) {
      assert.ok(chunk.endsWith('paragraph.') || chunk.endsWith('paragraph.\n') || chunk.endsWith('paragraph.\n\n'),
        `chunk should end on a paragraph: ${JSON.stringify(chunk.slice(-30))}`);
    }
  }
});

test('splitMessage: never splits inside a code fence', () => {
  // Construct a message where the natural paragraph-cut would land inside a fence.
  const head = 'a'.repeat(1900);
  const fence = '\n```js\n' + 'b'.repeat(500) + '\n```\n';
  const out = splitMessage(head + fence);
  for (const chunk of out) {
    const opens = (chunk.match(/```/g) || []).length;
    assert.equal(opens % 2, 0, `chunk has odd number of fences: ${chunk}`);
  }
});

test('splitMessage: empty input returns empty array', () => {
  assert.deepEqual(splitMessage(''), []);
  assert.deepEqual(splitMessage('   '), []);
});

test('splitMessage: mid-fence forced cut keeps every chunk balanced', () => {
  const text = 'a'.repeat(1000) + '\n```js\n' + 'b'.repeat(2500) + '\n```';
  const out = splitMessage(text);
  for (const chunk of out) {
    const opens = (chunk.match(/```/g) || []).length;
    assert.equal(opens % 2, 0, `chunk has odd fences: ${JSON.stringify(chunk.slice(0, 50))}…`);
    assert.ok(chunk.length <= 2000, `chunk over limit: ${chunk.length}`);
  }
});

test('splitMessage: pathological all-backticks input still produces balanced chunks', () => {
  const text = '```'.repeat(700);
  const out = splitMessage(text);
  for (const chunk of out) {
    const opens = (chunk.match(/```/g) || []).length;
    assert.equal(opens % 2, 0, `chunk has odd fences (length ${chunk.length})`);
    assert.ok(chunk.length <= 2000, `chunk over limit: ${chunk.length}`);
  }
});
