import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvents, formatReport } from '../../../user-data/scripts/discord-bot-health.js';

const NOW = new Date('2026-04-29T12:00:00Z').getTime();
const PERIOD = 7 * 24 * 3600 * 1000;
function ts(daysAgo) {
  return new Date(NOW - daysAgo * 24 * 3600 * 1000).toISOString();
}

test('analyze: empty event list → IDLE verdict, zero totals', () => {
  const a = analyzeEvents([], { now: NOW, periodMs: PERIOD });
  assert.match(a.verdict, /^IDLE/);
  assert.equal(a.totals.runs, 0);
  assert.equal(a.cost, 0);
});

test('analyze: only ok runs → GREEN verdict', () => {
  const events = [
    { ts: ts(1), event: 'run', status: 'ok', totalCostUsd: 0.05 },
    { ts: ts(2), event: 'run', status: 'ok', totalCostUsd: 0.10 },
    { ts: ts(3), event: 'run', status: 'ok', totalCostUsd: 0.07 },
  ];
  const a = analyzeEvents(events, { now: NOW, periodMs: PERIOD });
  assert.match(a.verdict, /^GREEN/);
  assert.equal(a.totals.runs, 3);
  assert.equal(a.totals.ok, 3);
  assert.equal(a.totals.error, 0);
  assert.ok(Math.abs(a.cost - 0.22) < 1e-9, `expected 0.22, got ${a.cost}`);
});

test('analyze: low-error rate (<10%) → YELLOW', () => {
  const events = [];
  for (let i = 0; i < 20; i++) events.push({ ts: ts(i % 7), event: 'run', status: 'ok' });
  events.push({ ts: ts(0), event: 'run', status: 'error', error: "code: 'TIMEOUT' details" });
  const a = analyzeEvents(events, { now: NOW, periodMs: PERIOD });
  assert.match(a.verdict, /^YELLOW/);
  assert.equal(a.totals.error, 1);
  assert.equal(a.errorTypeCounts.TIMEOUT, 1);
});

test('analyze: ≥10% error rate → RED', () => {
  const events = [
    { ts: ts(0), event: 'run', status: 'error', error: "code: 'NONZERO_EXIT'" },
    { ts: ts(1), event: 'run', status: 'error', error: "code: 'NONZERO_EXIT'" },
    { ts: ts(2), event: 'run', status: 'ok' },
  ];
  const a = analyzeEvents(events, { now: NOW, periodMs: PERIOD });
  assert.match(a.verdict, /^RED/);
  assert.equal(a.errorTypeCounts.NONZERO_EXIT, 2);
});

test('analyze: events outside the period are ignored', () => {
  const events = [
    { ts: ts(1), event: 'run', status: 'ok' },
    { ts: ts(30), event: 'run', status: 'error', error: "code: 'OLD'" },
  ];
  const a = analyzeEvents(events, { now: NOW, periodMs: PERIOD });
  assert.equal(a.totals.runs, 1);
  assert.equal(a.totals.error, 0);
  assert.match(a.verdict, /^GREEN/);
});

test('analyze: error code falls back to UNKNOWN when not parseable', () => {
  const events = [
    { ts: ts(0), event: 'run', status: 'error', error: 'something bad happened' },
  ];
  const a = analyzeEvents(events, { now: NOW, periodMs: PERIOD });
  assert.equal(a.errorTypeCounts.UNKNOWN, 1);
});

test('analyze: only first 3 errors are kept as samples', () => {
  const events = [];
  for (let i = 0; i < 10; i++) events.push({ ts: ts(i % 5), event: 'run', status: 'error', error: `code: 'TIMEOUT' #${i}` });
  const a = analyzeEvents(events, { now: NOW, periodMs: PERIOD });
  assert.equal(a.errorSamples.length, 3);
  assert.equal(a.errorTypeCounts.TIMEOUT, 10);
});

test('analyze: malformed entries are tolerated (no ts, NaN cost, etc.)', () => {
  const events = [
    null,
    { ts: ts(1), event: 'run', status: 'ok', totalCostUsd: NaN },
    { event: 'run', status: 'ok' }, // no ts
    { ts: ts(2), event: 'run', status: 'ok', totalCostUsd: 0.5 },
  ];
  const a = analyzeEvents(events.filter(Boolean), { now: NOW, periodMs: PERIOD });
  assert.equal(a.totals.runs, 2);
  assert.equal(a.cost, 0.5);
});

test('analyze: counts /help, /new, /cancel events separately from runs', () => {
  const events = [
    { ts: ts(0), event: 'help', status: 'ok' },
    { ts: ts(0), event: 'new', status: 'ok' },
    { ts: ts(0), event: 'cancel', status: 'ok' },
    { ts: ts(0), event: 'run', status: 'ok' },
  ];
  const a = analyzeEvents(events, { now: NOW, periodMs: PERIOD });
  assert.equal(a.totals.runs, 1);
  assert.equal(a.totals.helpNewCancel, 3);
});

test('analyze: counts channel_gone reply events', () => {
  const events = [
    { ts: ts(0), event: 'reply', status: 'channel_gone' },
    { ts: ts(0), event: 'reply', status: 'channel_gone' },
  ];
  const a = analyzeEvents(events, { now: NOW, periodMs: PERIOD });
  assert.equal(a.totals.channelGone, 2);
});

test('formatReport: includes verdict, totals, cost, sessions', () => {
  const events = [
    { ts: ts(0), event: 'run', status: 'ok', totalCostUsd: 0.42 },
  ];
  const a = analyzeEvents(events, { now: NOW, periodMs: PERIOD });
  const md = formatReport(a, { sessionCount: 7, status: { state: 'ready', ts: '2026-04-29T11:55:00.000Z' }, now: new Date(NOW) });
  assert.match(md, /Discord Bot Health/);
  assert.match(md, /\*\*GREEN/);
  assert.match(md, /Runs: \*\*1\*\*/);
  assert.match(md, /\$0\.4200/);
  assert.match(md, /Active sessions right now: 7/);
  assert.match(md, /ready @ 2026-04-29 11:55:00Z/);
});

test('formatReport: includes error breakdown when errors present', () => {
  const events = [
    { ts: ts(0), event: 'run', status: 'error', error: "code: 'TIMEOUT'", conversationKey: 'dm-1' },
    { ts: ts(1), event: 'run', status: 'error', error: "code: 'NONZERO_EXIT'", conversationKey: 'thread-2' },
  ];
  const a = analyzeEvents(events, { now: NOW, periodMs: PERIOD });
  const md = formatReport(a, {});
  assert.match(md, /Error breakdown/);
  assert.match(md, /TIMEOUT: 1/);
  assert.match(md, /NONZERO_EXIT: 1/);
  assert.match(md, /Sample error tails/);
  assert.match(md, /key=dm-1/);
});
