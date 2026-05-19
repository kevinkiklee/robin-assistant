import { accessSync, constants } from 'node:fs';
import type { Invariant } from '../types.ts';

export function userDataWritableInvariant(userDataDir: string): Invariant {
  return {
    name: 'install.user_data_writable',
    severity: 'critical',
    symptom:
      'Daemon cannot write to user-data/. Integration syncs silently drop; runtime state file fails to update.',
    cause: 'user-data/ path is not writable — permissions, full disk, or unmounted volume.',
    fix: 'Investigate `df -h` and `ls -la <user-data>`. No auto-repair; needs human attention.',
    check: () => {
      try {
        accessSync(userDataDir, constants.W_OK);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: `user-data not writable: ${err instanceof Error ? err.message : err}`,
          remediation: 'Check filesystem permissions and disk space.',
        };
      }
    },
  };
}
