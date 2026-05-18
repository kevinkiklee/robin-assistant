// Audit test: every name in policy lists resolves to a real invariant;
// every invariant has the required shape.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byName, INVARIANTS, phaseOrdered } from '../../../runtime/invariants/index.js';
import {
  BOOT_REPAIR_ALLOWLIST,
  CLI_BLOCKING_SET,
  LEVELS,
  PHASES,
} from '../../../runtime/invariants/policy.js';

test('every BOOT_REPAIR_ALLOWLIST name resolves to a real invariant', () => {
  for (const name of BOOT_REPAIR_ALLOWLIST) {
    assert.ok(byName.has(name), `unknown invariant in allowlist: ${name}`);
  }
});

test('every CLI_BLOCKING_SET name resolves to a real invariant', () => {
  for (const name of CLI_BLOCKING_SET) {
    assert.ok(byName.has(name), `unknown invariant in cli blocking set: ${name}`);
  }
});

test('every invariant has required shape', () => {
  for (const inv of INVARIANTS) {
    assert.ok(inv.name, 'name required');
    assert.ok(LEVELS.includes(inv.level), `bad level on ${inv.name}: ${inv.level}`);
    assert.ok(PHASES.includes(inv.phase), `bad phase on ${inv.name}: ${inv.phase}`);
    assert.ok(inv.surface, `surface required on ${inv.name}`);
    assert.equal(typeof inv.check, 'function', `${inv.name}.check`);
    assert.equal(typeof inv.explain, 'function', `${inv.name}.explain`);
    assert.ok(inv.runWhen, `runWhen required on ${inv.name}`);
  }
});

test('invariant names are unique', () => {
  const names = INVARIANTS.map((i) => i.name);
  assert.equal(new Set(names).size, names.length, 'duplicate invariant name');
});

test('phaseOrdered respects PHASES ordering', () => {
  const order = phaseOrdered();
  let lastPhaseIdx = -1;
  for (const inv of order) {
    const idx = PHASES.indexOf(inv.phase);
    assert.ok(idx >= lastPhaseIdx, `${inv.name} phase out of order`);
    lastPhaseIdx = idx;
  }
});

test('explain() returns non-empty markdown for every invariant', () => {
  for (const inv of INVARIANTS) {
    const md = inv.explain();
    assert.ok(typeof md === 'string' && md.length > 0, `${inv.name}.explain empty`);
  }
});

// Phase B (B.2) tightens `remediation` to required on every invariant. Two
// invariants are owned by a parallel lane (prompt-injection) and excluded
// from the assertion until that lane lands their remediation fields:
// `mcp.wiring_global_present` and `mcp.wiring_project_present`.
const REMEDIATION_PENDING = new Set(['mcp.wiring_global_present', 'mcp.wiring_project_present']);

test('remediation field is required + non-empty string|string[]', () => {
  for (const inv of INVARIANTS) {
    if (REMEDIATION_PENDING.has(inv.name)) continue;
    assert.ok(inv.remediation !== undefined, `${inv.name}.remediation required`);
    const isString = typeof inv.remediation === 'string' && inv.remediation.length > 0;
    const isStringArr =
      Array.isArray(inv.remediation) &&
      inv.remediation.length > 0 &&
      inv.remediation.every((s) => typeof s === 'string' && s.length > 0);
    assert.ok(
      isString || isStringArr,
      `${inv.name}.remediation must be non-empty string or string[]; got ${typeof inv.remediation} (${JSON.stringify(inv.remediation)})`,
    );
  }
});
