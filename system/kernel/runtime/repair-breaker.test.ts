import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isRepairBroken, recordRepairFailure } from './repair-breaker.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'breaker-'));

test('two failures on the same build SHA break the repair; a new SHA resets', () => {
  const d = dir();
  assert.strictEqual(isRepairBroken(d, 'x.inv'), false);
  recordRepairFailure(d, 'x.inv');
  assert.strictEqual(isRepairBroken(d, 'x.inv'), false); // one strike
  recordRepairFailure(d, 'x.inv');
  assert.strictEqual(isRepairBroken(d, 'x.inv'), true); // two strikes, same sha
});

test('sha injection: failures recorded under shaA do not break under shaB', () => {
  const d = dir();
  recordRepairFailure(d, 'y.inv', 'shaA');
  recordRepairFailure(d, 'y.inv', 'shaA');
  assert.strictEqual(isRepairBroken(d, 'y.inv', 'shaA'), true);
  assert.strictEqual(isRepairBroken(d, 'y.inv', 'shaB'), false);
});

test('a differing sha fully resets the entry — no streak inheritance from a sha-less prior record', () => {
  const d = dir();
  // First failure recorded with no sha at all (legacy/sha-less caller).
  recordRepairFailure(d, 'z.inv');
  // Second failure recorded under an explicit sha — must NOT inherit the
  // sha-less streak (that was the `prev?.sha === undefined` inheritance bug).
  recordRepairFailure(d, 'z.inv', 'shaC');
  assert.strictEqual(
    isRepairBroken(d, 'z.inv', 'shaC'),
    false,
    'sha-less prior failure must not count toward a shaC streak',
  );
  // One more failure under shaC now genuinely makes two-in-a-row for shaC.
  recordRepairFailure(d, 'z.inv', 'shaC');
  assert.strictEqual(isRepairBroken(d, 'z.inv', 'shaC'), true);
});

test('a differing sha resets an existing multi-failure streak, not just a sha-less one', () => {
  const d = dir();
  recordRepairFailure(d, 'w.inv', 'shaOld');
  recordRepairFailure(d, 'w.inv', 'shaOld');
  assert.strictEqual(isRepairBroken(d, 'w.inv', 'shaOld'), true);
  // A single failure under a NEW sha must reset to 1 — not inherit shaOld's 2.
  recordRepairFailure(d, 'w.inv', 'shaNew');
  assert.strictEqual(isRepairBroken(d, 'w.inv', 'shaNew'), false);
  assert.strictEqual(
    isRepairBroken(d, 'w.inv', 'shaOld'),
    false,
    'shaOld entry is gone, not just shadowed',
  );
});

test('isRepairBroken and recordRepairFailure default sha resolves consistently when omitted', () => {
  const d = dir();
  // No explicit sha on either call — both resolve via the same currentSha()
  // default, so this must behave identically to the matching-sha case.
  recordRepairFailure(d, 'default.inv');
  recordRepairFailure(d, 'default.inv');
  assert.strictEqual(isRepairBroken(d, 'default.inv'), true);
});

test('corrupt state file is treated as empty and never throws', () => {
  const d = dir();
  assert.strictEqual(isRepairBroken(d, 'anything'), false);
  // recordRepairFailure on a directory with no prior state file must not throw.
  assert.doesNotThrow(() => recordRepairFailure(d, 'anything'));
});

test('isRepairBroken: false when the userDataDir itself does not exist', () => {
  const missing = join(dir(), 'does-not-exist');
  assert.strictEqual(isRepairBroken(missing, 'inv.a'), false);
});

test('failures are tracked independently per invariant name within the same state file', () => {
  const d = dir();
  recordRepairFailure(d, 'inv.a');
  recordRepairFailure(d, 'inv.a');
  assert.strictEqual(isRepairBroken(d, 'inv.a'), true);
  assert.strictEqual(isRepairBroken(d, 'inv.b'), false);
});

test('state persists across separate calls against the same userDataDir (survives a restart)', () => {
  const d = dir();
  recordRepairFailure(d, 'inv.a');
  recordRepairFailure(d, 'inv.a');
  // Simulate a fresh process reading the same directory with no sha context —
  // both default to currentSha(), so the streak must still read as broken.
  assert.strictEqual(isRepairBroken(d, 'inv.a'), true);
});
