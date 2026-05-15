import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyEntry } from '../../../runtime/invariants/state.js';
import { decideRepair, manualAlertSet } from '../../../runtime/invariants/policy-decisions.js';

const inv = (level) => ({ name: `test.${level}`, level, runWhen: {} });

test('info level → auto', () => {
  assert.equal(decideRepair(inv('info'), emptyEntry()), 'auto');
});

test('warn level on first failure → auto', () => {
  assert.equal(decideRepair(inv('warn'), emptyEntry()), 'auto');
});

test('warn level after recent failed repair → manual', () => {
  const entry = { ...emptyEntry(), last_repair_at: 1000, last_repair_outcome: 'failed' };
  assert.equal(decideRepair(inv('warn'), entry), 'manual');
});

test('critical first failure → auto', () => {
  assert.equal(decideRepair(inv('critical'), emptyEntry()), 'auto');
});

test('critical second failure → auto', () => {
  const entry = { ...emptyEntry(), consecutive_failures: 1 };
  assert.equal(decideRepair(inv('critical'), entry), 'auto');
});

test('critical third+ failure → manual', () => {
  const entry = { ...emptyEntry(), consecutive_failures: 3 };
  assert.equal(decideRepair(inv('critical'), entry), 'manual');
});

test('manualAlertSet picks failing manual invariants', () => {
  const invariants = [inv('critical'), inv('warn')];
  const state = {
    invariants: {
      'test.critical': { ...emptyEntry(), consecutive_failures: 4, last_result_summary: { ok: false } },
      'test.warn': { ...emptyEntry(), last_result_summary: { ok: true } },
    },
  };
  const alerts = manualAlertSet(invariants, state);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].name, 'test.critical');
});
