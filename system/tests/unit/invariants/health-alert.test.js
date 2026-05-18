// Spec acceptance #5 for the invariants framework:
//   "Test that a forced-fail invariant produces a HEALTH_ALERT.md file when
//    consecutive_failures hits 3 with critical level."
//
// Gated on `ROBIN_INVARIANT_HEALTH_ALERT_TEST` so the heavier integration-y
// scenarios in this file are opt-in. The smaller unit tests for the
// writeHealthAlert helper run unconditionally — they exercise the same code
// path through a smaller surface and are cheap.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeHealthAlert } from '../../../runtime/invariants/health-alert.js';
import { run } from '../../../runtime/invariants/runner.js';
import { emptyEntry, emptyState, setEntry } from '../../../runtime/invariants/state.js';

const FAILED_CRITICAL_RESULT = { ok: false, error: 'simulated_force_fail' };

function tmpDir() {
  const d = join(
    tmpdir(),
    `robin-alert-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function fakeInvariant({
  name = 'test.synthetic_failure',
  level = 'critical',
  description = 'forced fail for HEALTH_ALERT acceptance test',
} = {}) {
  return {
    name,
    level,
    surface: 'runtime',
    phase: 'runtime',
    description,
    remediation: ['kill <daemon-pid>', 'inspect runtime/logs/daemon.log'],
    runWhen: {
      boot: { enabled: false },
      heartbeat: { enabled: true, cooldownMs: 0 },
      doctor: { enabled: true },
    },
    async check() {
      return FAILED_CRITICAL_RESULT;
    },
    explain() {
      return `### \`${name}\`\n\nSynthetic explainer body.`;
    },
  };
}

test('writeHealthAlert emits the file when a critical invariant has 3 consecutive failures', () => {
  const dir = tmpDir();
  try {
    const alertPath = join(dir, 'HEALTH_ALERT.md');
    const inv = fakeInvariant();
    const state = emptyState();
    const entry = {
      ...emptyEntry(),
      consecutive_failures: 3,
      last_failure_at: Date.now(),
      last_result_summary: FAILED_CRITICAL_RESULT,
    };
    setEntry(state, inv.name, entry);

    const out = writeHealthAlert(alertPath, [inv], state);
    assert.equal(out.wrote, true);
    assert.deepEqual(out.names, [inv.name]);
    assert.ok(existsSync(alertPath), 'HEALTH_ALERT.md was created');

    const md = readFileSync(alertPath, 'utf8');
    assert.match(md, /^# HEALTH_ALERT/);
    assert.match(md, new RegExp(`## ${inv.name} \\(critical\\)`));
    assert.match(md, /Consecutive failures:\*\* 3/);
    assert.match(md, /simulated_force_fail/);
    assert.match(md, /kill <daemon-pid>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeHealthAlert does not write when only a warn-level invariant has 1 failure', () => {
  const dir = tmpDir();
  try {
    const alertPath = join(dir, 'HEALTH_ALERT.md');
    const inv = fakeInvariant({ level: 'warn' });
    const state = emptyState();
    const entry = {
      ...emptyEntry(),
      consecutive_failures: 1,
      last_failure_at: Date.now(),
      last_result_summary: FAILED_CRITICAL_RESULT,
    };
    setEntry(state, inv.name, entry);
    const out = writeHealthAlert(alertPath, [inv], state);
    assert.equal(out.wrote, false);
    assert.equal(out.names.length, 0);
    assert.ok(!existsSync(alertPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeHealthAlert removes a stale file when the alert set becomes empty', () => {
  const dir = tmpDir();
  try {
    const alertPath = join(dir, 'HEALTH_ALERT.md');
    const inv = fakeInvariant();
    const state = emptyState();
    setEntry(state, inv.name, {
      ...emptyEntry(),
      consecutive_failures: 3,
      last_failure_at: Date.now(),
      last_result_summary: FAILED_CRITICAL_RESULT,
    });
    writeHealthAlert(alertPath, [inv], state);
    assert.ok(existsSync(alertPath));

    // Clear the failure → file should be removed on the next write.
    setEntry(state, inv.name, {
      ...emptyEntry(),
      last_pass_at: Date.now(),
      last_result_summary: { ok: true },
    });
    const out = writeHealthAlert(alertPath, [inv], state);
    assert.equal(out.wrote, false);
    assert.equal(out.removed, true);
    assert.ok(!existsSync(alertPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// End-to-end: drive a forced-fail invariant through the heartbeat runner three
// times and confirm the file lands on disk via the alertPath ctx wiring.
// Gated because it instantiates the runner against a real state file.
test('heartbeat runner writes HEALTH_ALERT.md after 3 consecutive critical failures', {
  skip: process.env.ROBIN_INVARIANT_HEALTH_ALERT_TEST !== '1' && process.env.CI !== 'true',
}, async () => {
  const dir = tmpDir();
  try {
    const statePath = join(dir, 'state.json');
    const alertPath = join(dir, 'HEALTH_ALERT.md');
    const lockDir = join(dir, 'locks');
    const inv = fakeInvariant();
    const ctx = { trigger: 'heartbeat', alertPath, log: { warn: () => {} } };
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      await run({
        trigger: 'heartbeat',
        ctx,
        statePath,
        lockDir,
        invariants: [inv],
      });
    }
    assert.ok(existsSync(alertPath), 'HEALTH_ALERT.md should exist after 3 fails');
    const md = readFileSync(alertPath, 'utf8');
    assert.match(md, new RegExp(inv.name));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
