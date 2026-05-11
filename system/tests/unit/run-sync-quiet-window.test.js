import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adjustForQuietWindow } from '../../io/integrations/_framework/run-sync.js';

const tz = 'America/New_York';
const ACTIVE = [4, 5, 6, 7, 8];

function hourInTz(d, zone) {
  const raw = Number.parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hour12: false }).format(d),
    10,
  );
  return raw === 24 ? 0 : raw;
}

test('null quiet_window returns nextRunAt unchanged', () => {
  const t = new Date('2026-05-10T13:30:00Z');
  assert.equal(adjustForQuietWindow(t, null).toISOString(), t.toISOString());
});

test('empty active_hours returns nextRunAt unchanged', () => {
  const t = new Date('2026-05-10T13:30:00Z');
  const out = adjustForQuietWindow(t, { tz, active_hours: [] });
  assert.equal(out.toISOString(), t.toISOString());
});

test('inside-window time stays unchanged', () => {
  // 5am EDT == 09:00 UTC during EDT.
  const at5amEDT = new Date('2026-05-10T09:00:00Z');
  assert.equal(hourInTz(at5amEDT, tz), 5);
  const out = adjustForQuietWindow(at5amEDT, { tz, active_hours: ACTIVE });
  assert.equal(out.toISOString(), at5amEDT.toISOString());
});

test('outside-window time advances forward into next active hour', () => {
  // 9:30am EDT == 13:30 UTC. 9 is NOT in active_hours [4..8], so we advance.
  // The next active hour boundary is 4am EDT next day.
  const at930am = new Date('2026-05-10T13:30:00Z');
  const result = adjustForQuietWindow(at930am, { tz, active_hours: ACTIVE });
  const adjustedHour = hourInTz(result, tz);
  assert.ok(
    ACTIVE.includes(adjustedHour),
    `expected hour in [${ACTIVE.join(',')}] EDT, got ${adjustedHour}`,
  );
  // Result must be later than input (forward-only).
  assert.ok(result.getTime() > at930am.getTime(), 'expected forward advance');
});

test('outside-window late evening advances to next morning', () => {
  // 11pm EDT == 03:00 UTC next day. Hour 23 not in active; should advance.
  const at11pmEDT = new Date('2026-05-11T03:00:00Z');
  assert.equal(hourInTz(at11pmEDT, tz), 23);
  const result = adjustForQuietWindow(at11pmEDT, { tz, active_hours: ACTIVE });
  const adjustedHour = hourInTz(result, tz);
  assert.ok(ACTIVE.includes(adjustedHour), `expected active hour, got ${adjustedHour}`);
  // Should land on the FIRST active hour reached (4am EDT).
  assert.equal(adjustedHour, 4);
});

test('boundary: hour just before window advances by minutes-to-hour', () => {
  // 3:45am EDT == 07:45 UTC. Hour 3 not active; advances 1 hour to land at 4am.
  const at345am = new Date('2026-05-10T07:45:00Z');
  assert.equal(hourInTz(at345am, tz), 3);
  const result = adjustForQuietWindow(at345am, { tz, active_hours: ACTIVE });
  // After 1 hour-step, candidate is 4:45am EDT == 08:45 UTC.
  assert.equal(hourInTz(result, tz), 4);
});

test('boundary: hour just after window advances ~20h to next 4am', () => {
  // 9:00am EDT == 13:00 UTC. Hour 9 just past window; advances ~19h.
  const at9am = new Date('2026-05-10T13:00:00Z');
  assert.equal(hourInTz(at9am, tz), 9);
  const result = adjustForQuietWindow(at9am, { tz, active_hours: ACTIVE });
  assert.equal(hourInTz(result, tz), 4);
  const hoursDelta = (result.getTime() - at9am.getTime()) / 3_600_000;
  assert.ok(hoursDelta >= 18 && hoursDelta <= 20, `expected ~19h delta, got ${hoursDelta}`);
});
