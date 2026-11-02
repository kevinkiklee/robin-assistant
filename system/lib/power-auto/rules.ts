import type { NetworkMode, Policies } from '../../kernel/config/schema.ts';
import type { BatteryState } from './macos.ts';

/**
 * Pure decisions for the power auto-monitor. Each returns the fields to write
 * into policies.yaml, or null when nothing should change. Two rules hold for
 * both: the monitor never overrides a state the operator set by hand (except
 * when a rule newly starts after that manual change), and it only undoes
 * states it applied itself (`set_by: auto`).
 */

type PowerPolicy = Policies['power'];
type NetworkPolicy = Policies['network'];
type QuietHours = NonNullable<PowerPolicy['auto']['quiet_hours']>;

const RANK: Record<NetworkMode, number> = { online: 0, 'local-only': 1, offline: 2 };

function strictest(a: NetworkMode, b: NetworkMode): NetworkMode {
  return RANK[a] >= RANK[b] ? a : b;
}

function minutesOf(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Start of the quiet-hours window `now` falls in (local time), or null when
 * outside it. A window whose end is earlier than its start crosses midnight.
 * start === end, or an unparseable time, means no window.
 */
export function quietHoursWindowStart(qh: QuietHours, now: Date): Date | null {
  const s = minutesOf(qh.start);
  const e = minutesOf(qh.end);
  if (s === null || e === null || s === e) return null;
  const t = now.getHours() * 60 + now.getMinutes();
  const inside = s < e ? t >= s && t < e : t >= s || t < e;
  if (!inside) return null;
  const start = new Date(now);
  start.setHours(Math.floor(s / 60), s % 60, 0, 0);
  if (s > e && t < e) start.setDate(start.getDate() - 1);
  return start;
}

export interface NetworkSignals {
  now: Date;
  /** null = unknown (helper not built, not macOS): treated as not metered. */
  metered: boolean | null;
  /** When this process first saw the current metered stretch; null when not metered. */
  meteredSince: Date | null;
}

export type NetworkPatch = Pick<
  NetworkPolicy,
  'mode' | 'set_by' | 'since' | 'reason' | 'prior_mode'
>;

export function decideNetwork(
  net: NetworkPolicy,
  quietHours: QuietHours | undefined,
  sig: NetworkSignals,
): NetworkPatch | null {
  const active: { reason: string; mode: NetworkMode; start: Date }[] = [];
  if (quietHours) {
    const start = quietHoursWindowStart(quietHours, sig.now);
    if (start) active.push({ reason: 'quiet_hours', mode: quietHours.mode, start });
  }
  if (net.on_metered && sig.metered === true) {
    active.push({ reason: 'metered', mode: net.on_metered, start: sig.meteredSince ?? sig.now });
  }
  const nowIso = sig.now.toISOString();

  if (active.length === 0) {
    // Nothing applies: undo only what the monitor itself applied.
    if (net.set_by !== 'auto') return null;
    const restore = net.prior_mode ?? 'online';
    if (net.mode === restore && !net.reason && !net.prior_mode) return null;
    return {
      mode: restore,
      set_by: undefined,
      since: nowIso,
      reason: undefined,
      prior_mode: undefined,
    };
  }

  const desired = active.map((r) => r.mode).reduce(strictest);
  const reason = active.map((r) => r.reason).join('+');
  const latestStart = Math.max(...active.map((r) => r.start.getTime()));

  if (net.set_by === 'auto') {
    if (net.mode === desired && net.reason === reason) return null;
    return {
      mode: desired,
      set_by: 'auto',
      since: net.mode === desired ? net.since : nowIso,
      reason,
      prior_mode: net.prior_mode,
    };
  }

  // A manual change made after every active rule started holds until a rule
  // starts again, so `robin online` during quiet hours sticks for that night.
  const since = net.since ? Date.parse(net.since) : Number.NaN;
  if (net.set_by === 'user' && Number.isFinite(since) && since >= latestStart) return null;
  // Never loosen a stricter mode the operator chose.
  if (RANK[net.mode] >= RANK[desired]) return null;
  return { mode: desired, set_by: 'auto', since: nowIso, reason, prior_mode: net.mode };
}

export interface PowerSignals {
  now: Date;
  battery: BatteryState;
  /** null = unknown. */
  lowPowerMode: boolean | null;
}

export type PowerPatch = Pick<PowerPolicy, 'state' | 'set_by' | 'since' | 'reason'>;

export function decidePower(power: PowerPolicy, sig: PowerSignals): PowerPatch | null {
  const auto = power.auto;
  const b = sig.battery;
  const onAc = b.available && b.charging;
  const batteryLow =
    auto.on_battery_below_pct !== undefined &&
    b.available &&
    b.percent !== null &&
    !b.charging &&
    b.percent < auto.on_battery_below_pct;
  const lowPower = auto.on_low_power_mode === 'paused' && sig.lowPowerMode === true;
  const nowIso = sig.now.toISOString();

  // Auto-pause only an active daemon; never clobber a state the user set.
  if (power.state === 'active' && (batteryLow || lowPower)) {
    return {
      state: 'paused',
      set_by: 'auto',
      since: nowIso,
      reason: batteryLow ? 'battery' : 'low_power_mode',
    };
  }

  // Auto-resume only a pause this monitor applied, once its cause is gone. A
  // battery pause (or one from before `reason` existed) still waits for AC and
  // honours auto_resume_on_ac; a Low Power Mode pause lifts when the mode does.
  if (power.state !== 'paused' || power.set_by !== 'auto' || batteryLow || lowPower) return null;
  const resume =
    power.reason === 'low_power_mode' ? true : onAc && (auto.auto_resume_on_ac ?? true);
  return resume ? { state: 'active', set_by: 'auto', since: nowIso, reason: undefined } : null;
}
