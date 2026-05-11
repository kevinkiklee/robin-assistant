// Unit tests for rollup-registry — entry shape, projection, kill-switch.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRegistry,
  getEnabledEntries,
} from '../../cognition/telemetry/rollup-registry.js';

test('buildRegistry returns the four built-in entries', () => {
  const reg = buildRegistry();
  const names = reg.map((e) => e.name).sort();
  assert.deepEqual(names, [
    'cadence_telemetry_hot',
    'intuition_telemetry',
    'meta_cognition_telemetry',
    'recall_log_eval',
  ]);
});

test('every entry has the expected shape', () => {
  const reg = buildRegistry();
  for (const e of reg) {
    assert.equal(typeof e.name, 'string', 'name string');
    assert.equal(typeof e.cursorName, 'string', 'cursorName string');
    assert.equal(typeof e.sourceTable, 'string', 'sourceTable string');
    assert.equal(typeof e.select, 'function', 'select fn');
    assert.equal(typeof e.project, 'function', 'project fn');
    assert.equal(typeof e.faculty, 'string', 'faculty string');
    assert.ok(Array.isArray(e.event_kinds), 'event_kinds array');
  }
});

test('select() returns { sql, params } with cursor + cutoff parameters', () => {
  const reg = buildRegistry();
  const cursor = new Date('2026-05-11T13:00:00Z');
  const cutoff = new Date('2026-05-11T14:00:00Z');
  const cfg = { cadence_hot_steps: ['belief.', 'dream.'] };
  for (const e of reg) {
    const { sql, params } = e.select({ cursor, cutoff, cfg });
    assert.equal(typeof sql, 'string');
    assert.ok(sql.length > 0);
    assert.equal(params.cursor, cursor);
    assert.equal(params.cutoff, cutoff);
  }
});

test('getEnabledEntries filters by faculties_enabled', () => {
  const reg = buildRegistry();
  const enabled = getEnabledEntries(reg, {
    faculties_enabled: ['intuition', 'reinforcement'],
  });
  const names = enabled.map((e) => e.name).sort();
  // intuition_telemetry covers intuition; recall_log_eval covers both
  // intuition + reinforcement; cadence_telemetry_hot covers belief/dream
  // (excluded); meta_cognition_telemetry covers meta_cognition (excluded).
  assert.deepEqual(names, ['intuition_telemetry', 'recall_log_eval']);
});

test('getEnabledEntries returns empty when faculties_enabled is empty', () => {
  const reg = buildRegistry();
  const enabled = getEnabledEntries(reg, { faculties_enabled: [] });
  assert.equal(enabled.length, 0);
});

test('getEnabledEntries with all faculties returns all four entries', () => {
  const reg = buildRegistry();
  const enabled = getEnabledEntries(reg, {
    faculties_enabled: ['intuition', 'reinforcement', 'belief', 'dream', 'meta_cognition'],
  });
  assert.equal(enabled.length, 4);
});

test('intuition_telemetry entry projects to faculty=intuition, event_kind=recall', () => {
  const reg = buildRegistry();
  const entry = reg.find((e) => e.name === 'intuition_telemetry');
  const rowFamily = entry.project({
    hour: new Date('2026-05-11T14:00:00Z'),
    source: 'intuition',
    mmr_path: 'cosine',
    n: 3,
    latency_ms_sum: 60,
    tokens_injected_sum: 300,
    hits_sum: 6,
    query_chars_sum: 150,
  });
  assert.equal(rowFamily.length, 1);
  assert.equal(rowFamily[0].faculty, 'intuition');
  assert.equal(rowFamily[0].event_kind, 'recall');
  assert.deepEqual(rowFamily[0].dimensions, { source: 'intuition', mmr_path: 'cosine' });
  assert.equal(rowFamily[0].count, 3);
  assert.equal(rowFamily[0].metric_sums.latency_ms_sum, 60);
  assert.equal(rowFamily[0].metric_sums.tokens_injected_sum, 300);
});

test('intuition_telemetry handles null source / mmr_path as null dimension value', () => {
  const reg = buildRegistry();
  const entry = reg.find((e) => e.name === 'intuition_telemetry');
  const fam = entry.project({ hour: new Date(), source: null, mmr_path: null, n: 1 });
  assert.equal(fam[0].dimensions.source, null);
  assert.equal(fam[0].dimensions.mmr_path, null);
});

test('recall_log_eval entry splits into two event_kinds (recall_attribution + evaluate)', () => {
  const reg = buildRegistry();
  const entry = reg.find((e) => e.name === 'recall_log_eval');
  const rowFamily = entry.project({
    hour: new Date('2026-05-11T14:00:00Z'),
    outcome: 'reinforced',
    attribution_mode: 'citation',
    source: 'intuition',
    focus_block_present: false,
    n: 5,
    used_count_sum: 4,
    total_sum: 6,
    dropped_hits_sum: 0,
    elapsed_ms_sum: 80,
    focus_block_tokens_sum: 0,
  });
  const ids = rowFamily.map((r) => `${r.faculty}.${r.event_kind}`).sort();
  assert.deepEqual(ids, ['intuition.recall_attribution', 'reinforcement.evaluate']);
});

test('recall_log_eval skips recall_attribution row when attribution_mode is null', () => {
  const reg = buildRegistry();
  const entry = reg.find((e) => e.name === 'recall_log_eval');
  const rowFamily = entry.project({
    hour: new Date('2026-05-11T14:00:00Z'),
    outcome: 'reinforced',
    attribution_mode: null,
    source: 'intuition',
    focus_block_present: null,
    n: 2,
  });
  // Only the reinforcement.evaluate row.
  assert.equal(rowFamily.length, 1);
  assert.equal(rowFamily[0].faculty, 'reinforcement');
  assert.equal(rowFamily[0].event_kind, 'evaluate');
});

test('cadence_telemetry_hot entry splits by step prefix (belief vs dream)', () => {
  const reg = buildRegistry();
  const entry = reg.find((e) => e.name === 'cadence_telemetry_hot');
  const beliefRow = entry.project({
    hour: new Date('2026-05-11T14:00:00Z'),
    step: 'belief.call',
    success: true,
    n: 7,
    latency_ms_sum: 140,
  });
  assert.equal(beliefRow[0].faculty, 'belief');
  assert.equal(beliefRow[0].event_kind, 'call');
  const dreamRow = entry.project({
    hour: new Date('2026-05-11T14:00:00Z'),
    step: 'dream.gather',
    success: true,
    n: 4,
    latency_ms_sum: 200,
  });
  assert.equal(dreamRow[0].faculty, 'dream');
  assert.equal(dreamRow[0].event_kind, 'gather');
});

test('cadence_telemetry_hot select() builds OR clause from cfg.cadence_hot_steps', () => {
  const reg = buildRegistry();
  const entry = reg.find((e) => e.name === 'cadence_telemetry_hot');
  const cursor = new Date();
  const cutoff = new Date();
  const { sql, params } = entry.select({
    cursor,
    cutoff,
    cfg: { cadence_hot_steps: ['belief.', 'dream.', 'foo.'] },
  });
  assert.match(sql, /string::starts_with\(step, \$p0\)/);
  assert.match(sql, /string::starts_with\(step, \$p1\)/);
  assert.match(sql, /string::starts_with\(step, \$p2\)/);
  assert.equal(params.p0, 'belief.');
  assert.equal(params.p1, 'dream.');
  assert.equal(params.p2, 'foo.');
});

test('meta_cognition_telemetry entry projects under faculty=meta_cognition, event_kind=run', () => {
  const reg = buildRegistry();
  const entry = reg.find((e) => e.name === 'meta_cognition_telemetry');
  const fam = entry.project({
    hour: new Date('2026-05-11T14:00:00Z'),
    outcome: 'success',
    n: 1,
    tokens_in_sum: 200,
    tokens_out_sum: 50,
    latency_ms_sum: 1200,
    actions_proposed_sum: 3,
    actions_accepted_sum: 2,
  });
  assert.equal(fam.length, 1);
  assert.equal(fam[0].faculty, 'meta_cognition');
  assert.equal(fam[0].event_kind, 'run');
  assert.equal(fam[0].dimensions.outcome, 'success');
  assert.equal(fam[0].metric_sums.actions_accepted_sum, 2);
});
