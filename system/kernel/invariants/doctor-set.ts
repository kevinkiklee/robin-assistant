import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { RobinDb } from '../../brain/memory/db.ts';
import { resolveBuiltinIntegrationsRoot } from '../../integrations/_runtime/gc.ts';
import type { IntegrationManifest } from '../../integrations/_runtime/types.ts';
import { LOADED_DEEP_HASH, LOADED_SHA } from '../../lib/build-stamp.ts';
import { loadPolicies } from '../config/load.ts';
import {
  agentWorktreesBoundedInvariant,
  alertsHistoryBoundedInvariant,
  beliefEmbeddingsBoundedInvariant,
  captureVolumeSaneInvariant,
  daemonStableInvariant,
  dbReachableInvariant,
  dbSchemaCurrentInvariant,
  dbWalSizeBoundedInvariant,
  distCurrentInvariant,
  integrationDegradedInvariant,
  integrationStalenessInvariant,
  integrationsHealthyInvariant,
  integrationUnreachableInvariant,
  jobsDiscoverableInvariant,
  jobsErroringInvariant,
  jobsHistoryBoundedInvariant,
  jobsRetriesBoundedInvariant,
  logsRotationBoundedInvariant,
  noOrphansInvariant,
  orphanChildrenInvariant,
  recallLogBoundedInvariant,
  recallTopicsResolvableInvariant,
  type ScheduledIntegration,
  schedulerProgressingInvariant,
  sessionStateBoundedInvariant,
  userDataWritableInvariant,
  vecIndexSyncedInvariant,
} from './builtins/index.ts';
import type { Invariant } from './types.ts';

/**
 * Enumerate enabled, schedule-bearing integrations from disk (YAML-only, no module
 * import) so the staleness invariant can anchor freshness checks on cadence. Mirrors
 * the instance-name logic in loader.ts (dir-name for multi-instance dirs, otherwise
 * manifest.name). Skips manual and event schedules — staleness only applies to
 * time-driven crons.
 */
function listScheduledIntegrations(userData: string): ScheduledIntegration[] {
  // User-data extensions first so they shadow builtins with the same resolved name.
  const roots = [join(userData, 'extensions', 'integrations'), resolveBuiltinIntegrationsRoot()];
  const result: ScheduledIntegration[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('_') || entry.startsWith('.')) continue;
      const full = join(root, entry);
      if (!statSync(full).isDirectory()) continue;
      const manifestPath = join(full, 'integration.yaml');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as IntegrationManifest;
        const schedule = manifest?.schedule;
        if (!schedule || schedule === 'manual' || schedule.startsWith('event:')) continue;
        const instanceName = entry.includes('--') ? entry : (manifest.name ?? entry);
        if (seen.has(instanceName)) continue; // user-data wins; skip duplicate builtin
        seen.add(instanceName);
        result.push({ name: instanceName, cron: schedule });
      } catch {
        // Unparseable manifest — skip; can't determine cadence anyway.
      }
    }
  }
  return result;
}

/**
 * The repo root sits three directories above this module (`system/kernel/invariants/`
 * in dev, `dist/kernel/invariants/` compiled). NEVER derive it from process.cwd():
 * the daemon's launchd WorkingDirectory is user-data/, and `doctor.run` (jobs.ts)
 * calls `buildDoctorInvariants(db, userData)` with no repoRoot override — a
 * cwd-derived default there resolves to user-data/, which silently breaks every
 * repoRoot-based invariant (mcp.dist_current, agent.worktrees_bounded): each looks
 * for its target under user-data/ (dist/.build-stamp, .worktrees/), finds nothing,
 * and reads "nothing found" as "all clear" forever. Same fix, same reasoning as
 * `defaultRepoRoot()` in system/agent/runner-entry.ts.
 */
function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * The canonical doctor invariant set — shared by `robin doctor [--fix]` (CLI) and
 * the daily `doctor.run` job so the manual and unattended paths can never drift.
 * Lives in the kernel layer (not the CLI surface) so brain/cognition can import it
 * without an inverted brain → surfaces dependency.
 */
export function buildDoctorInvariants(
  db: RobinDb,
  userData: string,
  repoRoot: string = defaultRepoRoot(),
): Invariant[] {
  const bootsPath = join(userData, 'state', 'runtime', 'boots.json');
  return [
    userDataWritableInvariant(userData),
    dbReachableInvariant(db),
    dbSchemaCurrentInvariant(db),
    dbWalSizeBoundedInvariant(db),
    vecIndexSyncedInvariant(db),
    integrationsHealthyInvariant(db),
    integrationStalenessInvariant(db, {
      integrations: () => listScheduledIntegrations(userData),
      policies: () => loadPolicies(userData),
      bootsPath,
    }),
    // Network-class staleness: warning only, no repair → never escalates.
    integrationUnreachableInvariant(db, {
      integrations: () => listScheduledIntegrations(userData),
      policies: () => loadPolicies(userData),
      bootsPath,
    }),
    integrationDegradedInvariant(db),
    jobsDiscoverableInvariant(db),
    jobsErroringInvariant(db),
    captureVolumeSaneInvariant(db),
    jobsHistoryBoundedInvariant(db),
    sessionStateBoundedInvariant(db),
    jobsRetriesBoundedInvariant(db),
    alertsHistoryBoundedInvariant(db),
    beliefEmbeddingsBoundedInvariant(db),
    recallLogBoundedInvariant(db),
    logsRotationBoundedInvariant(join(userData, 'observability', 'logs')),
    daemonStableInvariant({ bootsPath }),
    schedulerProgressingInvariant(db, { userData }),
    noOrphansInvariant(db, { userData }),
    orphanChildrenInvariant(db),
    recallTopicsResolvableInvariant({ userData }),
    agentWorktreesBoundedInvariant(repoRoot),
    distCurrentInvariant({
      repoRoot,
      loadedSha: () => LOADED_SHA,
      loadedDeepHash: () => LOADED_DEEP_HASH,
    }),
  ];
}
