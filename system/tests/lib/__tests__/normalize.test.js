import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../normalize.js';

const baseCtx = { workspace: '/tmp/robin-e2e-abc', clockMs: Date.parse('2026-05-02T12:00:00Z'), extra: [] };

describe('normalize', () => {
  it('strips ANSI escapes', () => {
    assert.equal(normalize('\x1B[31mred\x1B[0m', baseCtx), 'red');
  });

  it('LF-normalizes line endings', () => {
    assert.equal(normalize('a\r\nb\rc', baseCtx), 'a\nb\nc');
  });

  it('replaces workspace prefix with <WS>', () => {
    assert.equal(normalize('path: /tmp/robin-e2e-abc/foo.md', baseCtx), 'path: <WS>/foo.md');
  });

  it('collapses ISO timestamps within ±1 day of clock', () => {
    const out = normalize('time: 2026-05-02T13:00:00.000Z', baseCtx);
    assert.equal(out, 'time: <TS>');
  });

  it('leaves ISO timestamps outside ±1 day window unchanged', () => {
    const out = normalize('time: 2020-01-01T00:00:00.000Z', baseCtx);
    assert.equal(out, 'time: 2020-01-01T00:00:00.000Z');
  });

  it('applies per-scenario normalizers last', () => {
    const ctx = { ...baseCtx, extra: [{ from: /req-\d+/g, to: 'req-<N>' }] };
    assert.equal(normalize('id: req-42', ctx), 'id: req-<N>');
  });
});
