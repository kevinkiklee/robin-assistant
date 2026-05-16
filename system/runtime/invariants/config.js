// Read the invariants-framework runtime flag.
//
// Source of truth: config.json under `invariants.enabled`.
// Values: false (default) | 'shadow' | true
//   - false   → runner not invoked from daemon
//   - 'shadow'→ runner executes; doctor renders legacy probes
//   - true    → runner is the source of truth
//
// The flag is read on every relevant call so a flip takes effect without
// daemon restart. Read failure → treat as disabled (defensive default).

import { readConfig } from '../../config/paths.js';

const DEFAULT = false;

export async function readInvariantsFlag(cfgReader = readConfig) {
  try {
    const cfg = await cfgReader();
    const v = cfg?.invariants?.enabled;
    if (v === true) return true;
    if (v === 'shadow') return 'shadow';
    return DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function isRunnerActive(flag) {
  return flag === true || flag === 'shadow';
}
