import { describe, loadCredentials } from '../../../agent/credentials/config.ts';
import { CredentialStateStore, statePath } from '../../../agent/credentials/state.ts';
import type { Invariant } from '../types.ts';

const DAY_MS = 86_400_000;
/** `claude setup-token` tokens last about a year. */
export const TOKEN_LIFETIME_DAYS = 365;
const WARN_DAYS = 30;

/** Days left on a subscription token, counted from the day it was first seen. */
export function daysLeft(firstSeenAtMs: number, nowMs: number): number {
  return Math.floor(TOKEN_LIFETIME_DAYS - (nowMs - firstSeenAtMs) / DAY_MS);
}

/**
 * Warns when a subscription token is about to lapse, or when the shared token
 * is configured without Robin's own (background work then pauses by design).
 * Messages name credentials via describe(); never a secret.
 */
export function credentialsExpiringInvariant(opts: {
  userData: string;
  env?: Record<string, string | undefined>;
  nowMs?: () => number;
}): Invariant {
  return {
    name: 'agent.credentials_expiring',
    severity: 'warning',
    symptom: 'A Claude credential is close to expiring or misconfigured.',
    cause:
      'Subscription tokens from `claude setup-token` last about a year; the shared account is only borrowed alongside a Robin credential.',
    fix: 'Run claude setup-token for that account and replace its CLAUDE_TOKEN_* value in daemon.env.',
    check: () => {
      const env = opts.env ?? process.env;
      const nowMs = (opts.nowMs ?? Date.now)();
      const creds = loadCredentials(env).filter((c) => c.kind === 'subscription');
      const problems: string[] = [];
      if (creds.some((c) => c.name === 'shared') && !creds.some((c) => c.name === 'robin')) {
        problems.push(
          'CLAUDE_TOKEN_SHARED is set without CLAUDE_TOKEN_ROBIN — background work is paused (it never borrows your account without a Robin credential)',
        );
      }
      const state = new CredentialStateStore(statePath(opts.userData)).read();
      for (const c of creds) {
        const cs = state.credentials[c.id];
        // A renewed token (new fingerprint) starts fresh: not yet used.
        if (!cs || cs.fingerprint !== c.fingerprint) continue;
        const first = cs.firstSeenAtMs;
        if (first === undefined) continue;
        const left = daysLeft(first, nowMs);
        if (left <= WARN_DAYS) {
          problems.push(
            `${describe(c)} expires in ${Math.max(left, 0)}d — renew it before background work stops`,
          );
        }
      }
      return problems.length === 0 ? { ok: true } : { ok: false, message: problems.join('; ') };
    },
  };
}
