import type { Invariant } from '../types.ts';

/**
 * Auto-land's verify gate runs inside a macOS seatbelt sandbox and holds every
 * branch on any other platform (`system/agent/auto-land.ts`). With auto-land
 * enabled off darwin, nothing ever lands and nothing says why — surface it.
 * No `repair()`: the remedy is a config decision.
 */
export function autoLandSandboxInvariant(opts: {
  autoLandEnabled: () => boolean;
  platform?: string;
}): Invariant {
  const platform = opts.platform ?? process.platform;
  return {
    name: 'agent.auto_land_sandbox',
    severity: 'warning',
    symptom:
      'agent.auto_land is on, but this platform has no OS sandbox for the auto-land checks, so no agent branch can land.',
    cause:
      'Auto-land verifies a branch inside a macOS seatbelt sandbox and fails closed (holds the branch for review) on any other platform.',
    fix: 'Expected on Linux until the bubblewrap gate ships (cloud plan M7). To silence, set agent.auto_land: false.',
    check: () => {
      if (!opts.autoLandEnabled() || platform === 'darwin') return { ok: true };
      return {
        ok: false,
        message:
          'auto-land is enabled but this platform has no OS sandbox for its checks — every verified K branch is held for review',
      };
    },
  };
}
