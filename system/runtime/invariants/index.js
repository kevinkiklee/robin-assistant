// Invariants registry.
//
// Two sources:
//   1. The static system-side registry below — explicit manifest, no globbing.
//   2. Per-integration invariants — each loaded manifest's `<dir>/invariants/*.js`,
//      discovered at runtime via loadPerIntegrationInvariants().
//
// To add a system-side invariant:
//   1. Create system/runtime/invariants/<name>.js with default export {name, level, phase, ...}
//   2. Import it below.
//   3. Add it to INVARIANTS (the array order within a phase is the run order).
//   4. Run `pnpm test system/tests/unit/invariants/registry-audit.test.js`
//   5. Run `robin doctor --emit-runbook --write` (or let the precommit hook do it).
//
// To add a per-integration invariant: drop a `default`-exporting `.js` file into
// `<integration_dir>/invariants/`. It is auto-discovered after the integration's
// manifest is loaded.
//
// Invariant shape (additive fields, Phase A polish — A.4):
//   - remediation: string | string[]  — OPTIONAL. Per-symptom remediation hint(s),
//     consumed by `robin doctor`'s runbook emitter. Phase B will tighten to
//     required + backfill all existing invariants. Phase A only opens the door.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getIntegrationDirs } from '../../config/data-store.js';
import { loadManifests } from '../../io/integrations/_framework/manifest-loader.js';
import daemonEmbedderLoadAge from './daemon.embedder-load-age.js';
import daemonHeartbeating from './daemon.heartbeating.js';
import dbAuthenticated from './db.authenticated.js';
import dbDaemonReachable from './db.daemon-reachable.js';
import dbEmbedderProfileMatch from './db.embedder-profile-match.js';
import dbPendingRecallLogBounded from './db.pending-recall-log-bounded.js';
import installPointerPresent from './install.pointer-present.js';
import installUserDataWritable from './install.user-data-writable.js';
import integrationsNoStuckInFlight from './integrations.no-stuck-in-flight.js';
import integrationsSyncFreshness from './integrations.sync-freshness.js';
import mcpDaemonResponds from './mcp.daemon-responds.js';
import mcpWiringGlobalPresent from './mcp.wiring-global-present.js';
import mcpWiringProjectPresent from './mcp.wiring-project-present.js';
import { PHASES } from './policy.js';
import runtimeHooksSettingsPresent from './runtime.hooks-settings-present.js';
import runtimeHotReloadWatcherActive from './runtime.hot-reload-watcher-active.js';
import runtimeNoOrphanNodeTestProcs from './runtime.no-orphan-node-test-procs.js';
import runtimeNodeVersionPinned from './runtime.node-version-pinned.js';
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
  integrationsNoStuckInFlight,
  // runtime
  runtimeHooksSettingsPresent,
  runtimeNodeVersionPinned,
  runtimeNoOrphanNodeTestProcs,
  schedulerNoStuckInFlight,
  daemonEmbedderLoadAge,
  runtimeHotReloadWatcherActive,
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

/**
 * Scan every loaded integration manifest for an `invariants/` subdirectory and
 * return the default-exported invariant modules found there.
 *
 * Each integration owns its own invariants — e.g. lunch_money's pending↔cleared
 * dedupe check only makes sense when lunch_money is installed, so it lives at
 * `user-data/io/integrations/lunch_money/invariants/no-dupes.js` rather than in
 * the system-side registry.
 *
 * Failures (missing dir, bad module) are warned-and-skipped, not thrown — one
 * broken integration must not block discovery of the others.
 */
export async function loadPerIntegrationInvariants(dirs = getIntegrationDirs()) {
  const out = [];
  let loaded;
  try {
    ({ loaded } = await loadManifests(dirs));
  } catch (e) {
    console.warn(`loadPerIntegrationInvariants: manifest scan failed: ${e.message}`);
    return out;
  }
  for (const m of loaded) {
    if (!m?._dir) continue;
    const dir = join(m._dir, 'invariants');
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.js')) continue;
      const path = join(dir, f);
      try {
        const mod = await import(pathToFileURL(path).href);
        const inv = mod.default ?? mod.invariant;
        if (inv && typeof inv === 'object' && inv.name) {
          out.push(inv);
        } else {
          console.warn(`per-integration invariant ${m.name}/${f}: missing default export`);
        }
      } catch (e) {
        console.warn(`per-integration invariant ${m.name}/${f}: ${e.message}`);
      }
    }
  }
  return out;
}

/**
 * Static system-side invariants concatenated with per-integration invariants
 * discovered from loaded manifests. The result is phase-ordered.
 *
 * Async because manifest discovery touches the filesystem. Sync consumers
 * (registry-audit tests, runbook with explicit input) can still use
 * `phaseOrdered()` against `INVARIANTS` directly.
 */
export async function getAllInvariants() {
  const perIntegration = await loadPerIntegrationInvariants();
  return phaseOrdered([...INVARIANTS, ...perIntegration]);
}
