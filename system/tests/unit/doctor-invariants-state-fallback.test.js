// `robin doctor` is probe-only by design — it builds an invariant ctx with no
// `db`/`dbFactory`, so DB-touching invariants return `{ ok: false, error:
// 'no_db_handle' }`. The daemon's heartbeat tick evaluates the same invariants
// with a real DB and writes the verdict to invariants-state.json.
//
// `maybePromoteWithDaemonState` is the bridge: when the doctor process gets
// `no_db_handle`, it looks up the daemon's last verdict and promotes the
// result to ok when both the state file and the per-invariant verdict are
// fresh enough. This file exercises the three required edge cases.

import assert from 'node:assert';
import test from 'node:test';
import { maybePromoteWithDaemonState } from '../../runtime/cli/commands/doctor.js';

const NOW = Date.parse('2026-05-18T15:00:00.000Z');

function fakeInvariant({ cadenceMs = 60_000 } = {}) {
  return { name: 'db.authenticated', runWhen: { heartbeat: { cooldownMs: cadenceMs } } };
}

function fakeResult(error = 'no_db_handle') {
  return { name: 'db.authenticated', error };
}

function stateWithEntry({ generatedAgoMs, lastPassAgoMs, ok = true }) {
  return {
    generated_at: new Date(NOW - generatedAgoMs).toISOString(),
    invariants: {
      'db.authenticated': {
        last_pass_at: NOW - lastPassAgoMs,
        last_result_summary: { ok },
      },
    },
  };
}

test('promotes no_db_handle to ok when state file is fresh and last_pass is within 2× cadence', () => {
  const result = fakeResult();
  const invariant = fakeInvariant({ cadenceMs: 60_000 });
  const state = stateWithEntry({ generatedAgoMs: 30_000, lastPassAgoMs: 90_000 });
  const promote = maybePromoteWithDaemonState({ result, invariant, state, now: NOW });
  assert.ok(promote, 'expected promotion');
  assert.strictEqual(promote.ageMs, 90_000);
});

test('does not promote when state file is stale (>10m generated_at)', () => {
  const result = fakeResult();
  const invariant = fakeInvariant({ cadenceMs: 60_000 });
  const state = stateWithEntry({ generatedAgoMs: 11 * 60 * 1000, lastPassAgoMs: 30_000 });
  const promote = maybePromoteWithDaemonState({ result, invariant, state, now: NOW });
  assert.strictEqual(promote, null);
});

test('does not promote when state file is missing or has no generated_at', () => {
  const result = fakeResult();
  const invariant = fakeInvariant();
  assert.strictEqual(
    maybePromoteWithDaemonState({ result, invariant, state: null, now: NOW }),
    null,
  );
  assert.strictEqual(maybePromoteWithDaemonState({ result, invariant, state: {}, now: NOW }), null);
  assert.strictEqual(
    maybePromoteWithDaemonState({
      result,
      invariant,
      state: { invariants: {}, generated_at: null },
      now: NOW,
    }),
    null,
  );
});

test('does not promote when last_pass is older than 2× cadence', () => {
  const result = fakeResult();
  const invariant = fakeInvariant({ cadenceMs: 60_000 });
  const state = stateWithEntry({ generatedAgoMs: 30_000, lastPassAgoMs: 5 * 60 * 1000 });
  const promote = maybePromoteWithDaemonState({ result, invariant, state, now: NOW });
  assert.strictEqual(promote, null);
});

test('does not promote when daemon last_result_summary.ok is false', () => {
  const result = fakeResult();
  const invariant = fakeInvariant();
  const state = stateWithEntry({ generatedAgoMs: 30_000, lastPassAgoMs: 30_000, ok: false });
  const promote = maybePromoteWithDaemonState({ result, invariant, state, now: NOW });
  assert.strictEqual(promote, null);
});

test('does not promote when state file has no entry for the invariant', () => {
  const result = fakeResult();
  const invariant = fakeInvariant();
  const state = { generated_at: new Date(NOW - 30_000).toISOString(), invariants: {} };
  const promote = maybePromoteWithDaemonState({ result, invariant, state, now: NOW });
  assert.strictEqual(promote, null);
});

test('does not promote when result error is something other than no_db_handle', () => {
  const result = { name: 'db.authenticated', error: 'anonymous_access' };
  const invariant = fakeInvariant();
  const state = stateWithEntry({ generatedAgoMs: 30_000, lastPassAgoMs: 30_000 });
  const promote = maybePromoteWithDaemonState({ result, invariant, state, now: NOW });
  assert.strictEqual(promote, null);
});

test('falls back to default cadence when invariant has no heartbeat.cooldownMs', () => {
  const result = fakeResult();
  const invariant = { name: 'db.authenticated' };
  // Within default 15m * 2 = 30m
  const state = stateWithEntry({ generatedAgoMs: 30_000, lastPassAgoMs: 20 * 60 * 1000 });
  const promote = maybePromoteWithDaemonState({ result, invariant, state, now: NOW });
  assert.ok(promote);
  assert.strictEqual(promote.ageMs, 20 * 60 * 1000);
});

test('honors a custom fileStaleMs threshold', () => {
  const result = fakeResult();
  const invariant = fakeInvariant({ cadenceMs: 60_000 });
  const state = stateWithEntry({ generatedAgoMs: 3 * 60 * 1000, lastPassAgoMs: 30_000 });
  // Default 10m → would promote; 2m → does not.
  assert.ok(maybePromoteWithDaemonState({ result, invariant, state, now: NOW }));
  assert.strictEqual(
    maybePromoteWithDaemonState({ result, invariant, state, now: NOW, fileStaleMs: 2 * 60 * 1000 }),
    null,
  );
});

test('does not promote when generated_at is malformed', () => {
  const result = fakeResult();
  const invariant = fakeInvariant();
  const state = {
    generated_at: 'not-a-real-iso-string',
    invariants: {
      'db.authenticated': { last_pass_at: NOW - 1000, last_result_summary: { ok: true } },
    },
  };
  const promote = maybePromoteWithDaemonState({ result, invariant, state, now: NOW });
  assert.strictEqual(promote, null);
});
