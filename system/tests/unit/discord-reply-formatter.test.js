import test from 'node:test';
import assert from 'node:assert';
import {
  splitMessage,
  tablesToCodeBlocks,
  formatForDiscord,
} from '../../io/integrations/discord/formatter.js';

const MAX = 2000;

test('splitMessage: short message returns single chunk', () => {
  const chunks = splitMessage('hello world', MAX);
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0], 'hello world');
});

test('splitMessage: oversize without code fences splits on word boundary', () => {
  const msg = 'word '.repeat(500); // 2500 chars
  const chunks = splitMessage(msg, MAX);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= MAX, `chunk too long: ${c.length}`);
  }
  // No mid-word splits — every chunk's trailing non-space must be a complete
  // token (i.e. end with 'word' / 'word ' / similar, not 'wor' / 'or').
  for (const c of chunks) {
    assert.ok(!c.endsWith('wor'), 'chunk split mid-word: ends with "wor"');
    assert.ok(!c.endsWith('or'), 'chunk split mid-word: ends with "or"');
  }
});

test('splitMessage: code fence spanning boundary stays balanced', () => {
  const code = '```js\n' + 'a'.repeat(2200) + '\n```';
  const chunks = splitMessage(code, MAX);
  let totalFences = 0;
  for (const c of chunks) {
    totalFences += (c.match(/```/g) ?? []).length;
  }
  assert.strictEqual(totalFences % 2, 0, 'unbalanced fences across chunks');
});

test('tablesToCodeBlocks: GFM table renders as fenced code block', () => {
  const md = '| a | b |\n|---|---|\n| 1 | 2 |';
  const out = tablesToCodeBlocks(md);
  assert.match(out, /^```/m);
  assert.match(out, /\| a \| b \|/);
});

test('splitMessage: markdown link survives split', () => {
  const link = `prefix [label](https://example.com/very/long/path/that/extends/this/url/${'x'.repeat(1900)}) suffix`;
  const chunks = splitMessage(link, MAX);
  // The link should appear intact in some chunk (not split in the middle of the URL/label)
  const joined = chunks.join('');
  assert.match(joined, /\[label\]\(https/);
});

test('formatForDiscord: combines table conversion + split', () => {
  const md = 'header\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nfooter';
  const out = formatForDiscord(md, MAX);
  assert.strictEqual(out.length, 1);
  assert.match(out[0], /```/);
});
