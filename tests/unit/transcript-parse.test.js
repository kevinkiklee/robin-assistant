import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractTurns } from '../../src/capture/transcript.js';

function tmpJsonl(lines) {
  const dir = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  return path;
}

test('extracts simple text user + assistant turn pair', () => {
  const path = tmpJsonl([
    { type: 'user', message: { role: 'user', content: 'fix the bug' } },
    {
      type: 'assistant',
      message: { role: 'assistant', content: 'Done.', ts: '2026-05-10T12:00:00Z' },
    },
  ]);
  const t = extractTurns({ transcriptPath: path, tailBytes: 8192 });
  assert.equal(t.userText, 'fix the bug');
  assert.equal(t.assistantText, 'Done.');
  assert.equal(t.hasToolCalls, false);
});

test('extracts text from assistant message with array content (text + tool_use blocks)', () => {
  const path = tmpJsonl([
    { type: 'user', message: { role: 'user', content: 'list files' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running ls.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
  ]);
  const t = extractTurns({ transcriptPath: path, tailBytes: 8192 });
  assert.equal(t.assistantText, 'Running ls.');
  assert.equal(t.hasToolCalls, true);
});

test('skips tool_result user messages and walks back to the human prompt', () => {
  const path = tmpJsonl([
    { type: 'user', message: { role: 'user', content: 'use the tool' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'X', input: {} }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a', content: 'result' }],
      },
    },
    { type: 'assistant', message: { role: 'assistant', content: 'finished' } },
  ]);
  const t = extractTurns({ transcriptPath: path, tailBytes: 8192 });
  assert.equal(t.userText, 'use the tool');
  assert.equal(t.assistantText, 'finished');
});

test('tolerates malformed final line (partial flush)', () => {
  const path = tmpJsonl([
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: { role: 'assistant', content: 'hello' } },
  ]);
  // Append a partial line simulating a mid-write race.
  appendFileSync(path, '{"type":"assist', 'utf8');
  const t = extractTurns({ transcriptPath: path, tailBytes: 8192 });
  assert.equal(t.assistantText, 'hello');
});

test('returns all-nulls when no assistant turn in window', () => {
  const path = tmpJsonl([{ type: 'user', message: { role: 'user', content: 'just a user msg' } }]);
  const t = extractTurns({ transcriptPath: path, tailBytes: 8192 });
  assert.equal(t.assistantText, null);
  assert.equal(t.userText, null);
});

test('returns userText=null when only a long tool chain fits in window before assistant', () => {
  const path = tmpJsonl([
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a', content: 'r1' }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'b', content: 'r2' }],
      },
    },
    { type: 'assistant', message: { role: 'assistant', content: 'done' } },
  ]);
  const t = extractTurns({ transcriptPath: path, tailBytes: 8192 });
  assert.equal(t.userText, null);
  assert.equal(t.assistantText, 'done');
});

test('returns empty result on missing transcript', () => {
  const t = extractTurns({ transcriptPath: '/nonexistent/path.jsonl', tailBytes: 8192 });
  assert.equal(t.assistantText, null);
  assert.equal(t.userText, null);
  assert.equal(t.hasToolCalls, false);
});
