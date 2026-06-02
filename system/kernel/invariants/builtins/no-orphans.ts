import { join } from 'node:path';
import type { RobinDb } from '../../../brain/memory/db.ts';
import {
  findOrphans,
  gcOrphanIntegrationTicks,
  gcRemovedIntegrationState,
  resolveBuiltinIntegrationsRoot,
} from '../../../integrations/_runtime/gc.ts';
import { listOnDiskIntegrationNames } from '../../../integrations/_runtime/loader.ts';
import type { Invariant } from '../types.ts';

/**
 * A removed integration must not leave tombstones: its `integration.<name>.tick`
 * cron rows and `integration_state` heartbeat rows otherwise linger and show up in
 * `robin integrations` as phantoms (last synced days ago, looking broken when gone
 * — the github case). `gc.ts` imports only node:* + a type, so this kernel check
 * reuses it with no import cycle.
 *
 * SAFETY: the orphan set is keyed on directories ON DISK, never the loaded set — a
 * compile error keeps the dir, so a transiently-broken extension is never mistaken
 * for a deletion (its OAuth tokens survive). `warning` severity: phantoms are
 * cosmetic, but the daily doctor / `--fix` GCs them via `repair`.
 */
export function noOrphansInvariant(db: RobinDb, opts: { userData: string }): Invariant {
  const liveSets = () => {
    const userDataRoot = join(opts.userData, 'extensions/integrations');
    const onDiskNames = listOnDiskIntegrationNames([
      resolveBuiltinIntegrationsRoot(),
      userDataRoot,
    ]);
    const liveTickNames = new Set([...onDiskNames].map((n) => `integration.${n}.tick`));
    return { onDiskNames, liveTickNames };
  };
  return {
    name: 'state.no_orphans',
    severity: 'warning',
    symptom:
      'A removed integration still appears in `robin integrations` as a phantom (last synced days ago, looking broken).',
    cause:
      'Deleting an integration leaves its integration.<name>.tick cron rows and integration_state heartbeat rows behind.',
    fix: 'Run `robin doctor --fix` (the daily doctor auto-GCs these). Keyed on on-disk dirs, so a transiently-broken extension keeps its tokens.',
    check: () => {
      const { onDiskNames, liveTickNames } = liveSets();
      const { orphanTickCrons, orphanStateNames } = findOrphans(db, liveTickNames, onDiskNames);
      if (orphanTickCrons.length + orphanStateNames.length === 0) return { ok: true };
      const parts: string[] = [];
      if (orphanTickCrons.length) parts.push(`${orphanTickCrons.length} orphan tick cron(s)`);
      if (orphanStateNames.length) parts.push(`state for ${orphanStateNames.join(', ')}`);
      return {
        ok: false,
        message: `orphaned: ${parts.join('; ')}`,
        remediation: 'robin doctor --fix',
      };
    },
    repair: () => {
      const { onDiskNames, liveTickNames } = liveSets();
      gcOrphanIntegrationTicks(db, liveTickNames);
      gcRemovedIntegrationState(db, onDiskNames);
    },
  };
}
