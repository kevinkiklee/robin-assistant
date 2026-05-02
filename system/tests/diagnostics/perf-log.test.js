// system/tests/perf-log.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPerfLog, capPerfLog } from '../../scripts/diagnostics/lib/perf-log.js';

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'perf-log-'));
  mkdirSync(join(ws, 'user-data/runtime/state'), { recursive: true });
  return ws;
}

describe('perf-log', () => {
  it('appendPerfLog writes one TSV line', () => {
    const ws = setup();
    appendPerfLog(ws, { hook: 'UserPromptSubmit', duration_ms: 95, reason: 'timeout' });
    const text = readFileSync(join(ws, 'user-data/runtime/state/hook-perf.log'), 'utf8');
    const cols = text.trim().split('\t');
    assert.equal(cols.length, 4);
    assert.equal(cols[1], 'UserPromptSubmit');
    assert.equal(cols[2], '95');
    assert.equal(cols[3], 'timeout');
  });

  it('capPerfLog trims to N most recent lines', () => {
    const ws = setup();
    for (let i = 0; i < 10; i++) appendPerfLog(ws, { hook: 'h', duration_ms: i, reason: `r${i}` });
    capPerfLog(ws, 3);
    const lines = readFileSync(join(ws, 'user-data/runtime/state/hook-perf.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.ok(lines[2].includes('r9'));
  });
});
