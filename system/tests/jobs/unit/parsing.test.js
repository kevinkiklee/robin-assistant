import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJobFrontmatter, validateJobDef, mergeOverride } from '../../../scripts/jobs/lib/frontmatter.js';
import { parseCron, validateCron, cronMatches, cronNext, cronPrev, expectedIntervalMs, inActiveWindow } from '../../../scripts/jobs/lib/cron.js';

describe('parseJobFrontmatter', () => {
  test('parses scalar fields with type coercion', () => {
    const { frontmatter, body } = parseJobFrontmatter(`---
name: dream
description: hello
runtime: agent
enabled: true
schedule: "0 4 * * *"
timeout_minutes: 30
---
body here`);
    assert.equal(frontmatter.name, 'dream');
    assert.equal(frontmatter.description, 'hello');
    assert.equal(frontmatter.runtime, 'agent');
    assert.equal(frontmatter.enabled, true);
    assert.equal(frontmatter.schedule, '0 4 * * *');
    assert.equal(frontmatter.timeout_minutes, 30);
    assert.equal(body, 'body here');
  });

  test('parses inline arrays', () => {
    const { frontmatter } = parseJobFrontmatter(`---
name: x
triggers: ["a", "b", "c"]
---
`);
    assert.deepEqual(frontmatter.triggers, ['a', 'b', 'c']);
  });

  test('parses nested objects (active window)', () => {
    const { frontmatter } = parseJobFrontmatter(`---
name: rangers
active:
  from_month_day: "10-01"
  to_month_day: "06-30"
---
`);
    assert.deepEqual(frontmatter.active, { from_month_day: '10-01', to_month_day: '06-30' });
  });

  test('strips inline comments', () => {
    const { frontmatter } = parseJobFrontmatter(`---
name: x
schedule: "0 4 * * *"  # daily 4am
enabled: true # on by default
---
`);
    assert.equal(frontmatter.schedule, '0 4 * * *');
    assert.equal(frontmatter.enabled, true);
  });

  test('handles missing frontmatter', () => {
    const { frontmatter, body } = parseJobFrontmatter('just body, no frontmatter');
    assert.deepEqual(frontmatter, {});
    assert.equal(body, 'just body, no frontmatter');
  });
});

describe('validateJobDef', () => {
  const goodAgent = {
    frontmatter: { name: 'x', description: 'd', runtime: 'agent', schedule: '0 4 * * *' },
    body: 'prompt',
  };

  test('accepts a valid agent def', () => {
    assert.deepEqual(validateJobDef(goodAgent), { valid: true });
  });

  test('rejects missing required fields', () => {
    const r = validateJobDef({ frontmatter: { runtime: 'agent' }, body: '' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('name')));
    assert.ok(r.errors.some((e) => e.includes('description')));
  });

  test('schedule is optional (trigger-only protocols are valid)', () => {
    const r = validateJobDef({
      frontmatter: { name: 'x', description: 'd', runtime: 'agent', triggers: ['hello'] },
      body: 'protocol body',
    });
    assert.deepEqual(r, { valid: true });
  });

  test('rejects unknown runtime', () => {
    const r = validateJobDef({
      frontmatter: { name: 'x', description: 'd', runtime: 'magic', schedule: '0 4 * * *' },
      body: '',
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors[0].includes('invalid runtime'));
  });

  test('node runtime requires command', () => {
    const r = validateJobDef({
      frontmatter: { name: 'x', description: 'd', runtime: 'node', schedule: '0 4 * * *' },
      body: '',
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors[0].includes('command'));
  });

  test('rejects impossible active window dates', () => {
    const r = validateJobDef({
      frontmatter: {
        name: 'x',
        description: 'd',
        runtime: 'agent',
        schedule: '0 4 * * *',
        active: { from_month_day: '02-30', to_month_day: '04-30' },
      },
      body: '',
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('impossible date')));
  });

  test('accepts wraparound active window', () => {
    const r = validateJobDef({
      frontmatter: {
        name: 'x',
        description: 'd',
        runtime: 'agent',
        schedule: '0 4 * * *',
        active: { from_month_day: '10-01', to_month_day: '04-30' },
      },
      body: '',
    });
    assert.deepEqual(r, { valid: true });
  });

  test('override does not require schedule', () => {
    const r = validateJobDef({
      frontmatter: { name: 'x', description: 'd', runtime: 'agent', override: 'morning-briefing', enabled: true },
      body: '',
    });
    assert.deepEqual(r, { valid: true });
  });
});

describe('mergeOverride', () => {
  test('shallow override merges scalars; system body retained when override body empty', () => {
    const sys = {
      frontmatter: { name: 'a', runtime: 'agent', schedule: '0 4 * * *', enabled: false, timeout_minutes: 30 },
      body: 'system body',
    };
    const ov = {
      frontmatter: { override: 'a', enabled: true, timeout_minutes: 60 },
      body: '',
    };
    const merged = mergeOverride(sys, ov);
    assert.equal(merged.frontmatter.enabled, true);
    assert.equal(merged.frontmatter.timeout_minutes, 60);
    assert.equal(merged.frontmatter.runtime, 'agent');
    assert.equal(merged.body, 'system body');
    assert.ok(!('override' in merged.frontmatter));
  });

  test('full override replaces body', () => {
    const sys = { frontmatter: { name: 'a', runtime: 'agent' }, body: 'sys' };
    const ov = { frontmatter: { override: 'a', enabled: true }, body: 'overridden body' };
    const merged = mergeOverride(sys, ov);
    assert.equal(merged.body, 'overridden body');
  });

  test('nested object fields merge', () => {
    const sys = { frontmatter: { active: { from_month_day: '10-01', to_month_day: '06-30' } }, body: '' };
    const ov = { frontmatter: { override: 'x', active: { to_month_day: '04-30' } }, body: '' };
    const merged = mergeOverride(sys, ov);
    assert.deepEqual(merged.frontmatter.active, { from_month_day: '10-01', to_month_day: '04-30' });
  });
});

describe('parseCron / validateCron', () => {
  test('parses standard daily expression', () => {
    const c = parseCron('0 4 * * *');
    assert.deepEqual(c.minute, [0]);
    assert.deepEqual(c.hour, [4]);
    assert.equal(c.dayOfMonth.length, 31);
    assert.equal(c.month.length, 12);
    assert.equal(c.dayOfWeek.length, 7);
  });

  test('parses ranges and steps', () => {
    const c = parseCron('15 */6 * * *');
    assert.deepEqual(c.minute, [15]);
    assert.deepEqual(c.hour, [0, 6, 12, 18]);
  });

  test('parses lists', () => {
    const c = parseCron('0 9 1 1,4,7,10 *');
    assert.deepEqual(c.month, [1, 4, 7, 10]);
  });

  test('rejects out-of-range', () => {
    assert.equal(validateCron('0 25 * * *').valid, false);
    assert.equal(validateCron('0 0 32 * *').valid, false);
  });

  test('rejects bad token count', () => {
    assert.equal(validateCron('0 4 * *').valid, false);
  });
});

describe('cronMatches / cronNext / cronPrev', () => {
  test('daily 04:00 matches only at that time', () => {
    const c = parseCron('0 4 * * *');
    assert.equal(cronMatches(c, new Date(2026, 3, 29, 4, 0)), true);
    assert.equal(cronMatches(c, new Date(2026, 3, 29, 4, 1)), false);
    assert.equal(cronMatches(c, new Date(2026, 3, 29, 5, 0)), false);
  });

  test('cronNext returns next fire after given time', () => {
    const c = parseCron('0 4 * * *');
    const from = new Date(2026, 3, 29, 5, 0);
    const next = cronNext(c, from);
    assert.equal(next.getDate(), 30);
    assert.equal(next.getHours(), 4);
  });

  test('cronPrev returns most recent fire at or before time', () => {
    const c = parseCron('0 4 * * *');
    const from = new Date(2026, 3, 29, 5, 30);
    const prev = cronPrev(c, from);
    assert.equal(prev.getDate(), 29);
    assert.equal(prev.getHours(), 4);
  });

  test('weekly Sunday 10:00', () => {
    const c = parseCron('0 10 * * 0');
    const sunday = new Date(2026, 3, 26, 10, 0); // Sunday
    const monday = new Date(2026, 3, 27, 10, 0); // Monday
    assert.equal(cronMatches(c, sunday), true);
    assert.equal(cronMatches(c, monday), false);
  });

  test('expectedIntervalMs for daily ~ 24h', () => {
    const c = parseCron('0 4 * * *');
    const ms = expectedIntervalMs(c, new Date(2026, 3, 29, 0, 0));
    assert.equal(ms, 24 * 60 * 60 * 1000);
  });

  test('expectedIntervalMs for every 6h ~ 6h', () => {
    const c = parseCron('15 */6 * * *');
    const ms = expectedIntervalMs(c, new Date(2026, 3, 29, 0, 0));
    assert.equal(ms, 6 * 60 * 60 * 1000);
  });
});

describe('inActiveWindow', () => {
  test('always-active when no window', () => {
    assert.equal(inActiveWindow(null, new Date(2026, 6, 4)), true);
  });

  test('contiguous MM-DD window includes endpoints', () => {
    const w = { from_month_day: '04-01', to_month_day: '04-30' };
    assert.equal(inActiveWindow(w, new Date(2026, 3, 1)), true);
    assert.equal(inActiveWindow(w, new Date(2026, 3, 30)), true);
    assert.equal(inActiveWindow(w, new Date(2026, 4, 1)), false);
    assert.equal(inActiveWindow(w, new Date(2026, 2, 31)), false);
  });

  test('wraparound MM-DD window (Oct 1 → Apr 30)', () => {
    const w = { from_month_day: '10-01', to_month_day: '04-30' };
    assert.equal(inActiveWindow(w, new Date(2026, 9, 1)), true); // Oct 1
    assert.equal(inActiveWindow(w, new Date(2026, 11, 25)), true); // Dec 25
    assert.equal(inActiveWindow(w, new Date(2026, 0, 15)), true); // Jan 15
    assert.equal(inActiveWindow(w, new Date(2026, 3, 30)), true); // Apr 30
    assert.equal(inActiveWindow(w, new Date(2026, 4, 1)), false); // May 1
    assert.equal(inActiveWindow(w, new Date(2026, 8, 30)), false); // Sep 30
  });

  test('absolute YYYY-MM-DD window', () => {
    const w = { from: '2026-01-01', to: '2026-03-31' };
    assert.equal(inActiveWindow(w, new Date(2026, 0, 1)), true);
    assert.equal(inActiveWindow(w, new Date(2026, 2, 31)), true);
    assert.equal(inActiveWindow(w, new Date(2026, 3, 1)), false);
  });
});
