import type { Invariant } from '../types.ts';

export interface HeartbeatSource {
  lastTickAt: () => Date | null;
  maxIntervalMs: number;
  /** Epoch ms the host last woke from sleep (null = no sleep seen). The
   *  scheduler can't tick while the host sleeps, so silence counts from the
   *  later of the last tick and the wake. */
  lastWakeAt?: () => number | null;
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
      const woke = src.lastWakeAt?.() ?? null;
      const since = Date.now() - Math.max(last.getTime(), woke ?? 0);
      if (since > src.maxIntervalMs) {
        return {
          ok: false,
          message:
            woke !== null && woke > last.getTime()
              ? `no tick in the ${since}ms since host wake (max ${src.maxIntervalMs}ms)`
              : `last tick was ${since}ms ago (max ${src.maxIntervalMs}ms)`,
          remediation: 'restart daemon',
        };
      }
      return { ok: true };
    },
  };
}
