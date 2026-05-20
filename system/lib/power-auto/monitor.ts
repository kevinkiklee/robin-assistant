import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { resolveUserDataDir } from '../paths.ts';
import { loadPolicies } from '../../kernel/config/load.ts';
import { readBatteryStateMacOS, type BatteryState } from './macos.ts';
import { createLogger } from '../logging/logger.ts';

const CHECK_INTERVAL_MS = 30_000; // every 30s

export interface PowerAutoMonitorOptions {
  pollIntervalMs?: number;
  /** Optional override for testing — read battery state from this function instead of pmset */
  readBattery?: () => Promise<BatteryState>;
}

export class PowerAutoMonitor {
  private timer: NodeJS.Timeout | null = null;
  private log = createLogger({ module: 'power-auto' });
  private lastAuto: 'paused' | 'active' | null = null;

  constructor(private opts: PowerAutoMonitorOptions = {}) {}

  start(): void {
    if (this.timer) return;
    const interval = this.opts.pollIntervalMs ?? CHECK_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    const userData = resolveUserDataDir();
    let policies;
    try {
      policies = loadPolicies(userData);
    } catch {
      return; // no config to act on
    }
    const threshold = policies.power.auto.on_battery_below_pct;
    const autoResume = policies.power.auto.auto_resume_on_ac ?? true;
    if (threshold === undefined) return; // user hasn't opted in

    const reader = this.opts.readBattery ?? readBatteryStateMacOS;
    const battery = await reader();
    if (!battery.available || battery.percent === null) return;

    const lowAndUnplugged = !battery.charging && battery.percent < threshold;
    const currentlyAuto = this.lastAuto !== null;

    if (lowAndUnplugged && policies.power.state !== 'paused') {
      this.applyState(userData, policies, 'paused');
      this.lastAuto = 'paused';
      this.log.warn(
        { percent: battery.percent, threshold },
        'auto-pause: battery below threshold',
      );
    } else if (!lowAndUnplugged && currentlyAuto && autoResume) {
      this.applyState(userData, policies, 'active');
      this.lastAuto = null;
      this.log.info(
        { percent: battery.percent, charging: battery.charging },
        'auto-resume: power restored',
      );
    }
  }

  private applyState(
    userData: string,
    policies: ReturnType<typeof loadPolicies>,
    state: 'active' | 'paused',
  ): void {
    const path = join(userData, 'config', 'policies.yaml');
    const next = { ...policies, power: { ...policies.power, state } };
    writeFileSync(path, stringifyYaml(next));
  }
}
