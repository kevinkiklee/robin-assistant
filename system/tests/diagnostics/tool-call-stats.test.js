import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBaselineFromTranscripts } from '../../scripts/diagnostics/tool-call-stats.js';

function makeTranscriptDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tcs-'));
  return dir;
}

function writeJsonl(path, lines) {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('tool-call-stats baseline', () => {
  it('counts tool rounds and reads in a single assistant turn', () => {
    const dir = makeTranscriptDir();
    const tx = join(dir, 'session-a.jsonl');
    // One assistant turn with 2 tool blocks (= 2 rounds), 3 Read calls total.
    writeJsonl(tx, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/y' } },
      ] },
      { role: 'user', content: '[tool_result]' },
      { role: 'assistant', content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/z' } },
      ] },
      { role: 'user', content: '[tool_result]' },
      { role: 'assistant', content: 'final answer' },
    ]);

    const result = computeBaselineFromTranscripts([tx]);
    assert.equal(result.turns.length, 1, 'one user-to-final-answer turn');
    assert.equal(result.turns[0].rounds, 2);
    assert.equal(result.turns[0].reads, 3);
    assert.equal(result.aggregate.meanRounds, 2);
    assert.equal(result.aggregate.meanReads, 3);
  });

  it('returns empty aggregate when no transcripts found', () => {
    const result = computeBaselineFromTranscripts([]);
    assert.deepEqual(result.turns, []);
    assert.equal(result.aggregate.turns, 0);
  });
});
