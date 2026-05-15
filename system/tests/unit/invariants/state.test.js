import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  emptyEntry,
  emptyState,
  getEntry,
  pruneRepairHistory,
  readState,
  recordCheckResult,
  recordRepairResult,
  resetFailureCount,
  setEntry,
  writeState,
} from '../../../runtime/invariants/state.js';
import { withTempStateFile } from '../../helpers/invariant-fixtures.js';

test('readState returns empty state when file missing', () => {
  const result = readState('/nonexistent/path/state.json');
  assert.deepEqual(result, emptyState());
});

test('readState returns empty state when file is corrupt', () =>
  withTempStateFile(({ statePath }) => {
    writeFileSync(statePath, '{ not valid json', 'utf8');
    assert.deepEqual(readState(statePath), emptyState());
  }));

test('readState returns empty state when file is empty', () =>
  withTempStateFile(({ statePath }) => {
    writeFileSync(statePath, '', 'utf8');
    assert.deepEqual(readState(statePath), emptyState());
  }));

test('writeState writes atomically and read round-trips', () =>
  withTempStateFile(({ statePath }) => {
    const state = emptyState();
    setEntry(state, 'foo.bar', { ...emptyEntry(), consecutive_failures: 2 });
    writeState(statePath, state);
    const parsed = readState(statePath);
    assert.equal(parsed.invariants['foo.bar'].consecutive_failures, 2);
    assert.ok(parsed.generated_at);
  }));

test('writeState leaves no .tmp file behind on success', () =>
  withTempStateFile(({ dir, statePath }) => {
    writeState(statePath, emptyState());
    const tmpFiles = readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 0);
  }));

test('recordCheckResult on pass resets consecutive_failures', () => {
  const entry = { ...emptyEntry(), consecutive_failures: 5 };
  const out = recordCheckResult(entry, { ok: true }, 1000);
  assert.equal(out.consecutive_failures, 0);
  assert.equal(out.last_pass_at, 1000);
  assert.equal(out.last_checked_at, 1000);
  assert.equal(out.pending_repair_at, null);
});

test('recordCheckResult on fail increments consecutive_failures', () => {
  const entry = { ...emptyEntry(), consecutive_failures: 1 };
  const out = recordCheckResult(entry, { ok: false, error: 'x' }, 1000);
  assert.equal(out.consecutive_failures, 2);
  assert.equal(out.last_failure_at, 1000);
});

test('recordRepairResult appends to repair_history_30d on success', () => {
  const entry = { ...emptyEntry(), repair_history_30d: [] };
  const out = recordRepairResult(entry, { repaired: true, action: 'x' }, 1000);
  assert.deepEqual(out.repair_history_30d, [1000]);
  assert.equal(out.last_repair_outcome, 'succeeded');
});

test('recordRepairResult records failure without adding to history', () => {
  const entry = { ...emptyEntry(), repair_history_30d: [500] };
  const out = recordRepairResult(entry, { repaired: false, error: 'fail' }, 1000);
  assert.deepEqual(out.repair_history_30d, [500]);
  assert.equal(out.last_repair_outcome, 'failed');
});

test('pruneRepairHistory drops entries older than 30d', () => {
  const now = 30 * 24 * 60 * 60 * 1000 + 1000;
  const out = pruneRepairHistory([100, now - 100, now], now);
  assert.deepEqual(out, [now - 100, now]);
});

test('resetFailureCount sets consecutive_failures to 0', () => {
  const entry = { ...emptyEntry(), consecutive_failures: 7 };
  const out = resetFailureCount(entry);
  assert.equal(out.consecutive_failures, 0);
});

test('getEntry returns empty entry for unknown name', () => {
  const state = emptyState();
  assert.deepEqual(getEntry(state, 'unknown'), emptyEntry());
});
