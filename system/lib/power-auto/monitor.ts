import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { loadPolicies } from '../../kernel/config/load.ts';
import type { Policies } from '../../kernel/config/schema.ts';
import { createLogger } from '../logging/logger.ts';
import { resolveUserDataDir } from '../paths.ts';
import { type BatteryState, readBatteryStateMacOS } from './macos.ts';

const CHECK_INTERVAL_MS = 30_000; // every 30s

export interface PowerAutoMonitorOptions {
  pollIntervalMs?: number;
  /** Optional override for testing — read battery state from this function instead of pmset */
  readBattery?: () => Promise<BatteryState>;
}

export class PowerAutoMonitor {
  private timer: NodeJS.Timeout | null = null;
  private log = createLogger({ module: 'power-auto' });

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
    const threshold = policies.power.auto.on_battery_below_pct;
    const autoResume = policies.power.auto.auto_resume_on_ac ?? true;

    const reader = this.opts.readBattery ?? readBatteryStateMacOS;
    const battery = await reader();
    if (!battery.available || battery.percent === null) return;

    const onBattery = !battery.charging;

    // Auto-PAUSE requires a configured battery threshold (opt-in). Only auto-pause
    // an active daemon — never clobber a state the user set.
    if (
      threshold !== undefined &&
      onBattery &&
      battery.percent < threshold &&
      policies.power.state === 'active'
    ) {
      this.applyState(userData, policies, 'paused', 'auto');
      this.log.warn({ percent: battery.percent, threshold }, 'auto-pause: battery below threshold');
      return;
    }

    // Auto-RESUME when power is restored — but ONLY for a pause this monitor applied
    // (`set_by: 'auto'`). Provenance lives in policies.yaml, so this now fires across
    // daemon restarts (the previous in-memory flag reset on every restart, which is
    // how a transient auto-pause could strand Robin paused indefinitely). Decoupled
    // from `on_battery_below_pct` so `auto_resume_on_ac` isn't silently inert without
    // a pause threshold. A manual pause (`set_by: 'user'`) is deliberately left alone.
    if (
      !onBattery &&
      autoResume &&
      policies.power.state === 'paused' &&
      policies.power.set_by === 'auto'
    ) {
      this.applyState(userData, policies, 'active', 'auto');
      this.log.info(
        { percent: battery.percent, charging: battery.charging },
        'auto-resume: power restored (auto-managed pause cleared)',
      );
    }
  }

  private applyState(
    userData: string,
    policies: ReturnType<typeof loadPolicies>,
    state: 'active' | 'paused',
    setBy: 'auto' | 'user',
  ): void {
    const path = join(userData, 'config', 'policies.yaml');
    const next = {
      ...policies,
      power: { ...policies.power, state, set_by: setBy, since: new Date().toISOString() },
    };
    writeFileSync(path, stringifyYaml(next));
  }
}
