import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RobinDb } from '../../brain/memory/db.ts';
import { resolveBuiltinIntegrationsRoot } from '../../integrations/_runtime/gc.ts';
import type { IntegrationManifest } from '../../integrations/_runtime/types.ts';
import { loadPolicies } from '../config/load.ts';
import {
  agentWorktreesBoundedInvariant,
  alertsHistoryBoundedInvariant,
  captureVolumeSaneInvariant,
  daemonStableInvariant,
  dbReachableInvariant,
  dbSchemaCurrentInvariant,
  dbWalSizeBoundedInvariant,
  integrationDegradedInvariant,
  integrationStalenessInvariant,
  integrationsHealthyInvariant,
  jobsDiscoverableInvariant,
  jobsErroringInvariant,
  jobsHistoryBoundedInvariant,
  jobsRetriesBoundedInvariant,
  noOrphansInvariant,
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
 * The canonical doctor invariant set — shared by `robin doctor [--fix]` (CLI) and
 * the daily `doctor.run` job so the manual and unattended paths can never drift.
 * Lives in the kernel layer (not the CLI surface) so brain/cognition can import it
 * without an inverted brain → surfaces dependency.
 */
export function buildDoctorInvariants(
  db: RobinDb,
  userData: string,
  repoRoot: string = process.cwd(),
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
    }),
    integrationDegradedInvariant(db),
    jobsDiscoverableInvariant(db),
    jobsErroringInvariant(db),
    captureVolumeSaneInvariant(db),
    jobsHistoryBoundedInvariant(db),
    sessionStateBoundedInvariant(db),
    jobsRetriesBoundedInvariant(db),
    alertsHistoryBoundedInvariant(db),
    daemonStableInvariant({ bootsPath }),
    schedulerProgressingInvariant(db, { userData }),
    noOrphansInvariant(db, { userData }),
    recallTopicsResolvableInvariant({ userData }),
    agentWorktreesBoundedInvariant(repoRoot),
  ];
}
