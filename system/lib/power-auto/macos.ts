import { execFile } from 'node:child_process';
import { platform } from 'node:os';
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
