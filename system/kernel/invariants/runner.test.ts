import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInvariants } from './runner.ts';
import type { Invariant } from './types.ts';

const okInvariant: Invariant = {
  name: 'test.ok',
  severity: 'critical',
  symptom: 'never',
  cause: 'never',
  fix: 'nothing',
  check: () => ({ ok: true }),
};

const failInvariant: Invariant = {
  name: 'test.fail',
  severity: 'warning',
  symptom: 'always',
  cause: 'always',
  fix: 'restart it',
  check: () => ({ ok: false, message: 'something is wrong', remediation: 'try again' }),
};

const throwInvariant: Invariant = {
  name: 'test.throw',
  severity: 'critical',
  symptom: 'rare',
  cause: 'rare',
  fix: 'investigate',
  check: () => {
    throw new Error('exploded');
  },
};

test('invariants: passes ok invariant', async () => {
  const reports = await runInvariants([okInvariant]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].ok, true);
  assert.equal(reports[0].severity, 'critical');
});

test('invariants: captures failure with message + remediation', async () => {
  const reports = await runInvariants([failInvariant]);
  assert.equal(reports[0].ok, false);
  assert.equal(reports[0].message, 'something is wrong');
  assert.equal(reports[0].remediation, 'try again');
});

test('invariants: thrown error is caught and reported', async () => {
  const reports = await runInvariants([throwInvariant]);
  assert.equal(reports[0].ok, false);
  assert.match(reports[0].message ?? '', /exploded/);
});

test('invariants: records duration', async () => {
  const reports = await runInvariants([okInvariant]);
  assert.ok(reports[0].duration_ms >= 0);
});

test('invariants: --fix repairs a failing check then re-checks to ok', async () => {
  let broken = true;
  const inv: Invariant = {
    name: 'test.repairable',
    severity: 'warning',
    symptom: 's',
    cause: 'c',
    fix: 'f',
    check: () => ({ ok: !broken, message: broken ? 'broken' : undefined }),
    repair: () => {
      broken = false;
    },
  };
  // Without fix: stays failing, repair never runs.
  const noFix = await runInvariants([inv]);
  assert.equal(noFix[0].ok, false);
  assert.equal(noFix[0].repaired, undefined);

  broken = true; // reset
  const withFix = await runInvariants([inv], { fix: true });
  assert.equal(withFix[0].ok, true, 're-check passes after repair');
  assert.equal(withFix[0].repaired, true);
});

test('invariants: --fix records repair_error when repair throws; status is the re-check', async () => {
  const inv: Invariant = {
    name: 'test.repairthrows',
    severity: 'warning',
    symptom: 's',
    cause: 'c',
    fix: 'f',
    check: () => ({ ok: false, message: 'still broken' }),
    repair: () => {
      throw new Error('repair boom');
    },
  };
  const r = await runInvariants([inv], { fix: true });
  assert.equal(r[0].ok, false);
  assert.equal(r[0].repaired, true);
  assert.match(r[0].repair_error ?? '', /repair boom/);
});

test('invariants: --fix never repairs an already-ok check', async () => {
  let repairCalls = 0;
  const inv: Invariant = {
    name: 'test.oknofix',
    severity: 'warning',
    symptom: 's',
    cause: 'c',
    fix: 'f',
    check: () => ({ ok: true }),
    repair: () => {
      repairCalls++;
    },
  };
  const r = await runInvariants([inv], { fix: true });
  assert.equal(r[0].ok, true);
  assert.equal(r[0].repaired, undefined);
  assert.equal(repairCalls, 0);
});

test('invariants: beforeRepair returning false skips repair() but still re-checks', async () => {
  let repairCalls = 0;
  const inv: Invariant = {
    name: 'test.skippable',
    severity: 'warning',
    symptom: 's',
    cause: 'c',
    fix: 'f',
    check: () => ({ ok: false, message: 'still broken' }),
    repair: () => {
      repairCalls++;
    },
  };
  let beforeRepairCalledWith: Invariant | undefined;
  const r = await runInvariants([inv], {
    fix: true,
    beforeRepair: (i) => {
      beforeRepairCalledWith = i;
      return false;
    },
  });
  assert.equal(beforeRepairCalledWith?.name, 'test.skippable');
  assert.equal(repairCalls, 0, 'repair() must not run when beforeRepair returns false');
  assert.equal(r[0].ok, false, 'still re-checked — reaffirms the failing state');
  assert.equal(r[0].message, 'still broken');
  assert.equal(r[0].repaired, undefined, 'no repair was attempted, so `repaired` stays unset');
});

test('invariants: beforeRepair returning true proceeds with repair exactly like no hook', async () => {
  let broken = true;
  const inv: Invariant = {
    name: 'test.proceeds',
    severity: 'warning',
    symptom: 's',
    cause: 'c',
    fix: 'f',
    check: () => ({ ok: !broken, message: broken ? 'broken' : undefined }),
    repair: () => {
      broken = false;
    },
  };
  const r = await runInvariants([inv], { fix: true, beforeRepair: () => true });
  assert.equal(r[0].ok, true);
  assert.equal(r[0].repaired, true);
});

test('invariants: beforeRepair is never called for a check that is already ok', async () => {
  let beforeRepairCalls = 0;
  const inv: Invariant = {
    name: 'test.okskip',
    severity: 'warning',
    symptom: 's',
    cause: 'c',
    fix: 'f',
    check: () => ({ ok: true }),
    repair: () => {},
  };
  await runInvariants([inv], {
    fix: true,
    beforeRepair: () => {
      beforeRepairCalls++;
      return true;
    },
  });
  assert.equal(beforeRepairCalls, 0);
});

test('invariants: onRepairError fires with the invariant and the thrown error; report still carries repair_error', async () => {
  const inv: Invariant = {
    name: 'test.errorroute',
    severity: 'warning',
    symptom: 's',
    cause: 'c',
    fix: 'f',
    check: () => ({ ok: false, message: 'broken' }),
    repair: () => {
      throw new Error('repair boom');
    },
  };
  let captured: { inv?: Invariant; err?: unknown } = {};
  const r = await runInvariants([inv], {
    fix: true,
    onRepairError: (i, err) => {
      captured = { inv: i, err };
    },
  });
  assert.equal(captured.inv?.name, 'test.errorroute');
  assert.ok(captured.err instanceof Error);
  assert.match((captured.err as Error).message, /repair boom/);
  assert.match(r[0].repair_error ?? '', /repair boom/);
  assert.equal(r[0].ok, false);
});

test('invariants: onRepairError is not called when repair succeeds', async () => {
  let broken = true;
  let onRepairErrorCalls = 0;
  const inv: Invariant = {
    name: 'test.noerror',
    severity: 'warning',
    symptom: 's',
    cause: 'c',
    fix: 'f',
    check: () => ({ ok: !broken }),
    repair: () => {
      broken = false;
    },
  };
  await runInvariants([inv], { fix: true, onRepairError: () => onRepairErrorCalls++ });
  assert.equal(onRepairErrorCalls, 0);
});

test('invariants: no hooks passed — behavior is byte-identical to plain {fix:true} (regression pin)', async () => {
  let repairCalls = 0;
  const inv: Invariant = {
    name: 'test.nohooks',
    severity: 'warning',
    symptom: 's',
    cause: 'c',
    fix: 'f',
    check: () => ({ ok: repairCalls > 0 }),
    repair: () => {
      repairCalls++;
    },
  };
  const withHooksOmitted = await runInvariants([inv], { fix: true });
  assert.equal(withHooksOmitted[0].ok, true);
  assert.equal(withHooksOmitted[0].repaired, true);
  assert.equal(repairCalls, 1);
});
