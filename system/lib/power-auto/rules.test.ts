import assert from 'node:assert/strict';
import { test } from 'node:test';
import { networkSchema, powerSchema } from '../../kernel/config/schema.ts';
import { decideNetwork, decidePower, quietHoursWindowStart } from './rules.ts';

/** Local-time date on a fixed day, so the tests don't depend on the runner's zone. */
function at(hh: number, mm = 0, day = 15): Date {
  return new Date(2030, 2, day, hh, mm, 0, 0);
}

const overnight = { start: '22:00', end: '06:30', mode: 'local-only' as const };
const daytime = { start: '09:00', end: '17:00', mode: 'offline' as const };
const net = (o: Record<string, unknown> = {}) => networkSchema.parse({ mode: 'online', ...o });
const power = (o: Record<string, unknown> = {}, auto: Record<string, unknown> = {}) =>
  powerSchema.parse({ state: 'active', ...o, auto: { auto_resume_on_ac: true, ...auto } });
const noMeter = (now: Date) => ({ now, metered: false, meteredSince: null });

test('quiet hours: overnight window spans midnight and starts the previous evening', () => {
  assert.equal(quietHoursWindowStart(overnight, at(21, 59)), null);
  assert.deepEqual(quietHoursWindowStart(overnight, at(23, 0)), at(22, 0));
  assert.deepEqual(quietHoursWindowStart(overnight, at(3, 0)), at(22, 0, 14));
  assert.equal(quietHoursWindowStart(overnight, at(6, 30)), null, 'end is exclusive');
});

test('quiet hours: same-day window, and start === end or a bad time means none', () => {
  assert.deepEqual(quietHoursWindowStart(daytime, at(12, 0)), at(9, 0));
  assert.equal(quietHoursWindowStart(daytime, at(17, 0)), null);
  assert.equal(quietHoursWindowStart({ ...daytime, end: '09:00' }, at(9, 0)), null);
  assert.equal(quietHoursWindowStart({ ...daytime, start: '25:00' }, at(12, 0)), null);
});

test('network: entering quiet hours applies the mode and remembers the one it replaced', () => {
  const p = decideNetwork(net(), overnight, noMeter(at(23, 0)));
  assert.equal(p?.mode, 'local-only');
  assert.equal(p?.set_by, 'auto');
  assert.equal(p?.reason, 'quiet_hours');
  assert.equal(p?.prior_mode, 'online');
});

test('network: leaving quiet hours restores the prior mode and clears provenance', () => {
  const during = net({
    mode: 'local-only',
    set_by: 'auto',
    reason: 'quiet_hours',
    prior_mode: 'online',
  });
  const p = decideNetwork(during, overnight, noMeter(at(7, 0)));
  assert.equal(p?.mode, 'online');
  assert.equal(p?.set_by, undefined);
  assert.equal(p?.prior_mode, undefined);
  // Once restored, a quiet tick changes nothing.
  assert.equal(decideNetwork(net({ mode: 'online' }), overnight, noMeter(at(7, 1))), null);
});

test('network: a manual change inside the window holds until the next window starts', () => {
  const manual = net({ mode: 'online', set_by: 'user', since: at(23, 30).toISOString() });
  assert.equal(decideNetwork(manual, overnight, noMeter(at(2, 0, 16))), null, 'same night: held');
  const next = decideNetwork(manual, overnight, noMeter(at(22, 5, 16)));
  assert.equal(next?.mode, 'local-only', 'next night: the rule applies again');
});

test('network: never loosens a stricter mode the operator set', () => {
  const off = net({ mode: 'offline', set_by: 'user', since: at(12, 0, 1).toISOString() });
  assert.equal(decideNetwork(off, overnight, noMeter(at(23, 0))), null);
  // And never "restores" a manual mode outside the window either.
  assert.equal(decideNetwork(off, overnight, noMeter(at(12, 0))), null);
});

test('network: metered applies on_metered; the strictest active rule wins', () => {
  const n = net({ on_metered: 'offline' });
  const sig = { now: at(23, 0), metered: true, meteredSince: at(22, 40) };
  const p = decideNetwork(n, overnight, sig);
  assert.equal(p?.mode, 'offline');
  assert.equal(p?.reason, 'quiet_hours+metered');
  // Metered without on_metered configured, or unknown, does nothing.
  assert.equal(decideNetwork(net(), undefined, sig), null);
  assert.equal(decideNetwork(n, undefined, { ...sig, metered: null }), null);
});

test('network: switching rules while auto-managed keeps the original prior mode', () => {
  const managed = net({
    mode: 'local-only',
    on_metered: 'offline',
    set_by: 'auto',
    reason: 'quiet_hours',
    prior_mode: 'online',
  });
  const p = decideNetwork(managed, overnight, {
    now: at(23, 0),
    metered: true,
    meteredSince: at(23, 0),
  });
  assert.equal(p?.mode, 'offline');
  assert.equal(p?.prior_mode, 'online');
});

const onBattery = (percent: number) => ({ available: true, charging: false, percent });
const onAc = (percent: number) => ({ available: true, charging: true, percent });

test('power: low battery pauses and AC resumes (existing behaviour kept)', () => {
  const p = decidePower(power({}, { on_battery_below_pct: 30 }), {
    now: at(12),
    battery: onBattery(20),
    lowPowerMode: false,
  });
  assert.deepEqual([p?.state, p?.reason], ['paused', 'battery']);
  const paused = power(
    { state: 'paused', set_by: 'auto', reason: 'battery' },
    { on_battery_below_pct: 30 },
  );
  assert.equal(
    decidePower(paused, { now: at(12), battery: onAc(21), lowPowerMode: false })?.state,
    'active',
  );
  const noResume = power(
    { state: 'paused', set_by: 'auto', reason: 'battery' },
    { on_battery_below_pct: 30, auto_resume_on_ac: false },
  );
  assert.equal(
    decidePower(noResume, { now: at(12), battery: onAc(21), lowPowerMode: false }),
    null,
  );
});

test('power: Low Power Mode pauses only when configured, and lifts with the mode even on battery', () => {
  const cfg = { on_low_power_mode: 'paused' };
  const sig = { now: at(12), battery: onBattery(80), lowPowerMode: true };
  assert.equal(decidePower(power(), sig), null, 'not configured');
  assert.equal(decidePower(power({}, { on_low_power_mode: 'active' }), sig), null);
  assert.deepEqual(
    [decidePower(power({}, cfg), sig)?.state, decidePower(power({}, cfg), sig)?.reason],
    ['paused', 'low_power_mode'],
  );
  const paused = power({ state: 'paused', set_by: 'auto', reason: 'low_power_mode' }, cfg);
  assert.equal(decidePower(paused, { ...sig, lowPowerMode: true }), null, 'still on');
  assert.equal(decidePower(paused, { ...sig, lowPowerMode: false })?.state, 'active');
});

test('power: never resumes a manual pause', () => {
  const manual = power({ state: 'paused', set_by: 'user' }, { on_low_power_mode: 'paused' });
  assert.equal(decidePower(manual, { now: at(12), battery: onAc(90), lowPowerMode: false }), null);
});
