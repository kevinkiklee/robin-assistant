import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { loadPolicies } from '../../kernel/config/load.ts';
import type { Policies } from '../../kernel/config/schema.ts';
import { createLogger } from '../logging/logger.ts';
import { resolveUserDataDir } from '../paths.ts';
import {
  type BatteryState,
  type NetworkPathState,
  readBatteryStateMacOS,
  readLowPowerModeMacOS,
  readNetworkPathMacOS,
} from './macos.ts';
import { decideNetwork, decidePower } from './rules.ts';

const CHECK_INTERVAL_MS = 30_000; // every 30s

export interface PowerAutoMonitorOptions {
  pollIntervalMs?: number;
  /** Optional override for testing — read battery state from this function instead of pmset */
  readBattery?: () => Promise<BatteryState>;
  /** Test override for the Low Power Mode probe. */
  readLowPowerMode?: () => Promise<boolean | null>;
  /** Test override for the network-path (metered) probe. */
  readNetworkPath?: () => Promise<NetworkPathState>;
  /** Test override for the clock. */
  now?: () => Date;
}

export class PowerAutoMonitor {
  private timer: NodeJS.Timeout | null = null;
  private log = createLogger({ module: 'power-auto' });
  private meteredSince: Date | null = null;

  constructor(private opts: PowerAutoMonitorOptions = {}) {}

  start(): void {
    if (this.timer) return;
    // One-time visibility into the effective auto-power config. `auto_resume_on_ac`
    // used to be a silent no-op without `on_battery_below_pct`; log the real shape
    // so a misconfigured policy is diagnosable instead of mysteriously inert.
    try {
      const policies = loadPolicies(resolveUserDataDir());
      this.log.info(
        {
          auto_resume_on_ac: policies.power.auto.auto_resume_on_ac ?? true,
          on_battery_below_pct: policies.power.auto.on_battery_below_pct ?? null,
          on_low_power_mode: policies.power.auto.on_low_power_mode ?? null,
          quiet_hours: policies.power.auto.quiet_hours ?? null,
          on_metered: policies.network.on_metered ?? null,
        },
        'power auto-monitor started',
      );
    } catch {
      // no config yet — nothing to report
    }
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
    let policies: Policies;
    try {
      policies = loadPolicies(userData);
    } catch {
      return; // no config to act on
    }
    const now = this.opts.now?.() ?? new Date();
    const auto = policies.power.auto;

    // Probe only what a configured rule needs: each probe is a subprocess.
    const battery = await (this.opts.readBattery ?? readBatteryStateMacOS)();
    const lowPowerMode =
      auto.on_low_power_mode === 'paused'
        ? await (this.opts.readLowPowerMode ?? readLowPowerModeMacOS)()
        : null;
    let metered: boolean | null = null;
    if (policies.network.on_metered) {
      const path = await (this.opts.readNetworkPath ?? readNetworkPathMacOS)();
      metered = path.available ? path.metered : null;
    }
    // In-memory, so a daemon restart restarts the stretch: a manual override made
    // while on a metered network is re-applied once after a restart.
    if (metered === true) this.meteredSince ??= now;
    else this.meteredSince = null;

    const powerPatch = decidePower(policies.power, { now, battery, lowPowerMode });
    const networkPatch = decideNetwork(policies.network, auto.quiet_hours, {
      now,
      metered,
      meteredSince: this.meteredSince,
    });
    if (!powerPatch && !networkPatch) return;

    const next: Policies = {
      ...policies,
      power: powerPatch ? { ...policies.power, ...powerPatch } : policies.power,
      network: networkPatch ? { ...policies.network, ...networkPatch } : policies.network,
    };
    writeFileSync(join(userData, 'config', 'policies.yaml'), stringifyYaml(next));
    if (powerPatch) {
      this.log.warn(
        { state: powerPatch.state, reason: powerPatch.reason ?? null, percent: battery.percent },
        powerPatch.state === 'paused' ? 'auto-pause' : 'auto-resume',
      );
    }
    if (networkPatch) {
      this.log.warn(
        { from: policies.network.mode, to: networkPatch.mode, reason: networkPatch.reason ?? null },
        'auto network mode',
      );
    }
  }
}
