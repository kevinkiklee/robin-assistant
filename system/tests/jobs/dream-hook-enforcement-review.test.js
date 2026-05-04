// Tests for the hook-enforcement-review helper used by Dream Phase 3
// step 11.6 (and the standalone system/jobs/hook-enforcement-review.md
// protocol).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadTelemetryEntries,
  aggregate,
  buildCorrectionsNote,
  buildLearningQueueNote,
  buildSummary,
  THRESHOLDS,
} from '../../scripts/jobs/lib/hook-enforcement-review.js';

function makeWsWithLog(lines) {
  const ws = mkdtempSync(join(tmpdir(), 'her-'));
  const dir = join(ws, 'user-data/runtime/state/telemetry');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'protocol-override-enforcement.log'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  return ws;
}

describe('loadTelemetryEntries', () => {
  it('returns empty when log does not exist', () => {
    const ws = mkdtempSync(join(tmpdir(), 'her-empty-'));
    assert.deepEqual(loadTelemetryEntries(ws), []);
  });

  it('parses JSONL, skipping malformed lines', () => {
    const ws = makeWsWithLog([
      { ts: '2026-05-03T01:00:00.000Z', event: 'injected', protocol: 'a' },
    ]);
    // Append a malformed line.
    writeFileSync(
      join(ws, 'user-data/runtime/state/telemetry/protocol-override-enforcement.log'),
      JSON.stringify({ ts: '2026-05-03T01:00:00.000Z', event: 'injected', protocol: 'a' }) + '\n' +
      '{ malformed\n' +
      JSON.stringify({ ts: '2026-05-03T02:00:00.000Z', event: 'blocked', protocol: 'b' }) + '\n',
    );
    const got = loadTelemetryEntries(ws);
    assert.equal(got.length, 2);
    assert.equal(got[0].event, 'injected');
    assert.equal(got[1].event, 'blocked');
  });

  it('filters by sinceISO watermark', () => {
    const ws = makeWsWithLog([
      { ts: '2026-05-03T00:00:00.000Z', event: 'injected', protocol: 'old' },
      { ts: '2026-05-03T05:00:00.000Z', event: 'blocked', protocol: 'new' },
    ]);
    const got = loadTelemetryEntries(ws, '2026-05-03T01:00:00.000Z');
    assert.equal(got.length, 1);
    assert.equal(got[0].protocol, 'new');
  });

  it('treats entries with same ts as the watermark as not-since (strict greater)', () => {
    const ws = makeWsWithLog([
      { ts: '2026-05-03T01:00:00.000Z', event: 'blocked', protocol: 'a' },
    ]);
    const got = loadTelemetryEntries(ws, '2026-05-03T01:00:00.000Z');
    assert.equal(got.length, 0);
  });
});

describe('aggregate', () => {
  it('aggregates blocks by protocol with timestamps', () => {
    const agg = aggregate([
      { ts: 't1', event: 'blocked', protocol: 'daily-briefing' },
      { ts: 't2', event: 'blocked', protocol: 'daily-briefing' },
      { ts: 't3', event: 'blocked', protocol: 'lint' },
    ]);
    assert.equal(agg.blocked_count, 3);
    assert.equal(agg.blocks_by_protocol['daily-briefing'].count, 2);
    assert.deepEqual(agg.blocks_by_protocol['daily-briefing'].timestamps, ['t1', 't2']);
    assert.equal(agg.blocks_by_protocol['lint'].count, 1);
  });

  it('counts injected events', () => {
    const agg = aggregate([
      { ts: 't1', event: 'injected', protocol: 'daily-briefing', phrase: 'good morning' },
      { ts: 't2', event: 'injected', protocol: 'lint', phrase: 'lint' },
    ]);
    assert.equal(agg.injected_count, 2);
  });

  it('flags recurring blocks at threshold ≥2 (not ≥1)', () => {
    const agg = aggregate([
      { ts: 't1', event: 'blocked', protocol: 'daily-briefing' },
      { ts: 't2', event: 'blocked', protocol: 'daily-briefing' },
      { ts: 't3', event: 'blocked', protocol: 'lint' }, // count=1 → NOT recurring
    ]);
    assert.deepEqual(agg.recurring_blocks, ['daily-briefing']);
  });

  it('exposes BLOCK threshold = 2 for transparency', () => {
    assert.equal(THRESHOLDS.BLOCK, 2);
  });

  it('aggregates hook_error entries with full detail', () => {
    const agg = aggregate([
      { ts: 't1', event: 'hook_error', mode: 'onUserPromptSubmit', error_class: 'state_write_failed', message: 'EACCES' },
      { ts: 't2', event: 'hook_error', mode: 'onUserPromptSubmit', error_class: 'state_write_failed', message: 'EACCES again' },
      { ts: 't3', event: 'hook_error', mode: 'onUserPromptSubmit', error_class: 'state_write_failed', message: 'one more' },
    ]);
    assert.equal(agg.hook_errors.length, 3);
    assert.deepEqual(agg.repeated_error_classes, [{ error_class: 'state_write_failed', count: 3 }]);
  });

  it('does NOT flag error class with only 2 repeats (threshold = 3)', () => {
    const agg = aggregate([
      { ts: 't1', event: 'hook_error', mode: 'onPreToolUse', error_class: 'transient', message: '' },
      { ts: 't2', event: 'hook_error', mode: 'onPreToolUse', error_class: 'transient', message: '' },
    ]);
    assert.deepEqual(agg.repeated_error_classes, []);
  });

  it('returns clean shape on empty input', () => {
    const agg = aggregate([]);
    assert.equal(agg.blocked_count, 0);
    assert.equal(agg.injected_count, 0);
    assert.deepEqual(agg.recurring_blocks, []);
    assert.deepEqual(agg.hook_errors, []);
    assert.deepEqual(agg.repeated_error_classes, []);
  });
});

describe('buildCorrectionsNote', () => {
  it('formats a recurring-miss note with timestamps and the canonical follow-up line', () => {
    const note = buildCorrectionsNote('daily-briefing', { count: 3, timestamps: ['t1', 't2', 't3'] });
    assert.match(note, /daily-briefing blocked 3 times/);
    assert.match(note, /t1, t2, t3/);
    assert.match(note, /Hook is enforcing but model still attempts the wrong file/);
    assert.match(note, /injection text needs to be louder|model drift/);
  });

  it('the line is a valid capture-tag line for inbox/corrections', () => {
    const note = buildCorrectionsNote('lint', { count: 2, timestamps: ['x', 'y'] });
    assert.match(note, /^- \[correction\|origin=derived\]/);
  });
});

describe('buildLearningQueueNote', () => {
  it('mentions the error class and count', () => {
    const note = buildLearningQueueNote('state_write_failed', 5);
    assert.match(note, /state_write_failed/);
    assert.match(note, /5 times/);
  });
});

describe('buildSummary', () => {
  it('produces a single-line summary', () => {
    const agg = aggregate([
      { ts: 't1', event: 'blocked', protocol: 'a' },
      { ts: 't2', event: 'blocked', protocol: 'a' },
      { ts: 't3', event: 'blocked', protocol: 'b' },
      { ts: 't4', event: 'hook_error', mode: 'x', error_class: 'foo', message: '' },
    ]);
    const sum = buildSummary(agg);
    assert.equal(sum.split('\n').length, 1);
    assert.match(sum, /3 blocks/);
    assert.match(sum, /1 protocols/); // 'a' has 2, 'b' has 1; only 'a' is recurring
    assert.match(sum, /1 hook_errors/);
  });
});

describe('protocol file integration', () => {
  it('hook-enforcement-review.md has triggers: [] and required frontmatter', async () => {
    const { parseProtocolFrontmatter } = await import('../../scripts/lib/protocol-frontmatter.js');
    const { readFileSync } = await import('node:fs');
    const path = new URL('../../jobs/hook-enforcement-review.md', import.meta.url).pathname;
    const text = readFileSync(path, 'utf8');
    const { frontmatter } = parseProtocolFrontmatter(text);
    assert.equal(frontmatter.name, 'hook-enforcement-review');
    assert.deepEqual(frontmatter.triggers, []);
    assert.equal(frontmatter.dispatch, 'inline');
    assert.ok(frontmatter.model);
  });
});
