import type { Invariant } from '../types.ts';

export interface HeartbeatSource {
  lastTickAt: () => Date | null;
  maxIntervalMs: number;
}

export function daemonHeartbeatingInvariant(src: HeartbeatSource): Invariant {
  return {
    name: 'daemon.heartbeating',
    severity: 'critical',
    symptom: 'Scheduler stops claiming jobs. Daemon log goes silent.',
    cause: 'Event loop blocked, or a job handler is stuck synchronously.',
    fix: 'launchd / systemd should respawn the daemon. If it does not, send SIGTERM to the daemon PID.',
    check: () => {
      const last = src.lastTickAt();
      if (!last) return { ok: false, message: 'no tick recorded yet' };
      const since = Date.now() - last.getTime();
      if (since > src.maxIntervalMs) {
        return {
          ok: false,
          message: `last tick was ${since}ms ago (max ${src.maxIntervalMs}ms)`,
          remediation: 'restart daemon',
        };
      }
      return { ok: true };
    },
  };
}
