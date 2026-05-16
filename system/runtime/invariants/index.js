// Invariants registry. Explicit manifest — no directory globbing.
//
// To add an invariant:
//   1. Create system/runtime/invariants/<name>.js with default export {name, level, phase, ...}
//   2. Import it below.
//   3. Add it to INVARIANTS (the array order within a phase is the run order).
//   4. Run `pnpm test system/tests/unit/invariants/registry-audit.test.js`
//   5. Run `robin doctor --emit-runbook --write` (or let the precommit hook do it).

import daemonHeartbeating from './daemon.heartbeating.js';
import dbAuthenticated from './db.authenticated.js';
import dbDaemonReachable from './db.daemon-reachable.js';
import dbEmbedderProfileMatch from './db.embedder-profile-match.js';
import dbPendingRecallLogBounded from './db.pending-recall-log-bounded.js';
import installPointerPresent from './install.pointer-present.js';
import installUserDataWritable from './install.user-data-writable.js';
import integrationsLunchMoneyNoDupes from './integrations.lunch-money-no-dupes.js';
import integrationsSyncFreshness from './integrations.sync-freshness.js';
import mcpDaemonResponds from './mcp.daemon-responds.js';
import mcpWiringGlobalPresent from './mcp.wiring-global-present.js';
import mcpWiringProjectPresent from './mcp.wiring-project-present.js';
import { PHASES } from './policy.js';
import runtimeHooksSettingsPresent from './runtime.hooks-settings-present.js';
import runtimeNodeVersionPinned from './runtime.node-version-pinned.js';
import runtimeNoOrphanNodeTestProcs from './runtime.no-orphan-node-test-procs.js';
import schedulerNoStuckInFlight from './scheduler.no-stuck-in-flight.js';

export const INVARIANTS = [
  // Phase order matters; see PHASES in policy.js. Within a phase, registry order is run order.
  // paths
  installPointerPresent,
  installUserDataWritable,
  // db
  dbDaemonReachable,
  dbAuthenticated,
  dbEmbedderProfileMatch,
  dbPendingRecallLogBounded,
  // mcp
  mcpWiringProjectPresent,
  mcpWiringGlobalPresent,
  mcpDaemonResponds,
  // integrations
  integrationsSyncFreshness,
  integrationsLunchMoneyNoDupes,
  // runtime
  runtimeHooksSettingsPresent,
  runtimeNodeVersionPinned,
  runtimeNoOrphanNodeTestProcs,
  schedulerNoStuckInFlight,
  // meta
  daemonHeartbeating,
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
