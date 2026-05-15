// Invariants registry. Explicit manifest — no directory globbing.
//
// To add an invariant:
//   1. Create system/runtime/invariants/<name>.js with default export {name, level, phase, ...}
//   2. Import it below.
//   3. Add it to INVARIANTS (the array order within a phase is the run order).
//   4. Run `pnpm test system/tests/unit/invariants/registry-audit.test.js`
//   5. Run `robin doctor --emit-runbook --write` (or let the precommit hook do it).

import { PHASES } from './policy.js';

export const INVARIANTS = [
  // Phase order matters; see PHASES in policy.js. Within a phase, registry order is run order.
];

export const byName = new Map(INVARIANTS.map((i) => [i.name, i]));

export function byPhase(invariants = INVARIANTS) {
  const map = new Map(PHASES.map((p) => [p, []]));
  for (const inv of invariants) {
    const arr = map.get(inv.phase);
    if (!arr) throw new Error(`unknown phase '${inv.phase}' on invariant '${inv.name}'`);
    arr.push(inv);
  }
  return map;
}

export function phaseOrdered(invariants = INVARIANTS) {
  const map = byPhase(invariants);
  return PHASES.flatMap((p) => map.get(p));
}
