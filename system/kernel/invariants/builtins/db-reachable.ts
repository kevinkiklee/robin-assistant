import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Invariant } from '../types.ts';

export function dbReachableInvariant(db: RobinDb): Invariant {
  return {
    name: 'db.reachable',
    severity: 'critical',
    symptom: 'Recall and remember calls fail; scheduler ticks fail.',
    cause: 'SQLite connection has been closed or the file is unreadable.',
    fix: 'Restart the daemon: `launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon`. If the file is corrupt, restore with `robin db restore`.',
    check: () => {
      try {
        const row = db.prepare('SELECT 1 as alive').get() as { alive: number };
        return { ok: row.alive === 1 };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
