import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface BatteryState {
  available: boolean;
  charging: boolean;
  percent: number | null;
}

/**
 * Reads battery state via macOS `pmset -g batt`. Returns { available: false } on non-darwin.
 * `pmset` output looks like:
 *   Now drawing from 'Battery Power'
 *    -InternalBattery-0 (id=...)   42%; discharging; 2:34 remaining present: true
 */
export async function readBatteryStateMacOS(): Promise<BatteryState> {
  if (platform() !== 'darwin') return { available: false, charging: false, percent: null };
  try {
    const { stdout } = await execFileP('pmset', ['-g', 'batt']);
    const ac = /AC Power/i.test(stdout);
    const m = stdout.match(/(\d+)%/);
    const percent = m ? Number.parseInt(m[1], 10) : null;
    return { available: true, charging: ac, percent };
  } catch {
    return { available: false, charging: false, percent: null };
  }
}

/**
 * Parses `pmset -g` for Low Power Mode. macOS 26 reports `powermode` (0 auto,
 * 1 low power, 2 high power); older releases report `lowpowermode 0|1`.
 * Returns null when neither key is present (no such setting on this Mac).
 */
export function parseLowPowerMode(pmsetOutput: string): boolean | null {
  const legacy = pmsetOutput.match(/^\s*lowpowermode\s+(\d+)/m);
  if (legacy) return legacy[1] === '1';
  const mode = pmsetOutput.match(/^\s*powermode\s+(\d+)/m);
  if (mode) return mode[1] === '1';
  return null;
}

/** Low Power Mode on/off via `pmset -g`; null when unknown or not macOS. */
export async function readLowPowerModeMacOS(): Promise<boolean | null> {
  if (platform() !== 'darwin') return null;
  try {
    const { stdout } = await execFileP('pmset', ['-g']);
    return parseLowPowerMode(stdout);
  } catch {
    return null;
  }
}

export interface NetworkPathState {
  available: boolean;
  /** Expensive (Personal Hotspot, cellular) or constrained (Low Data Mode). */
  metered: boolean;
}

/** Parses the netpath helper's JSON line. */
export function parseNetPath(stdout: string): NetworkPathState {
  try {
    const j = JSON.parse(stdout.trim()) as { expensive?: unknown; constrained?: unknown };
    return { available: true, metered: j.expensive === true || j.constrained === true };
  } catch {
    return { available: false, metered: false };
  }
}

/** The compiled helper sits next to this module in dist/ (see build-netpath.mjs). */
const NETPATH_BIN = fileURLToPath(new URL('./netpath', import.meta.url));

/** Reads the current path's cost flags via the netpath helper; unavailable when it isn't built. */
export async function readNetworkPathMacOS(): Promise<NetworkPathState> {
  if (platform() !== 'darwin' || !existsSync(NETPATH_BIN)) {
    return { available: false, metered: false };
  }
  try {
    const { stdout } = await execFileP(NETPATH_BIN, [], { timeout: 5000 });
    return parseNetPath(stdout);
  } catch {
    return { available: false, metered: false };
  }
}
