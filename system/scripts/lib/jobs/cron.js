// Minimal cron-expression parser + utilities for the job system.
// Supports the standard 5-field cron: `minute hour day month dayOfWeek`.
// Each field allows: `*`, `N`, `N-M`, `N,M,O`, `*/N`.
// No second-field support, no L/W/# extensions.

const FIELD_BOUNDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day-of-week (0=Sun, 6=Sat)
];

function expandField(token, { min, max }) {
  if (token === '*') {
    const out = [];
    for (let i = min; i <= max; i++) out.push(i);
    return out;
  }
  // step: */N  or  range/step
  const stepMatch = token.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
  if (stepMatch) {
    const base = stepMatch[1];
    const step = Number.parseInt(stepMatch[2], 10);
    if (!Number.isFinite(step) || step <= 0) throw new Error(`invalid step: ${token}`);
    const range = base === '*' ? [min, max] : base.split('-').map((s) => Number.parseInt(s, 10));
    if (range.length === 1) range.push(max);
    const [lo, hi] = range;
    if (lo < min || hi > max || lo > hi) throw new Error(`out-of-range: ${token}`);
    const out = [];
    for (let i = lo; i <= hi; i += step) out.push(i);
    return out;
  }
  if (token.includes(',')) {
    const out = [];
    for (const part of token.split(',')) {
      for (const v of expandField(part, { min, max })) out.push(v);
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }
  if (token.includes('-')) {
    const [lo, hi] = token.split('-').map((s) => Number.parseInt(s, 10));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`invalid range: ${token}`);
    if (lo < min || hi > max || lo > hi) throw new Error(`out-of-range: ${token}`);
    const out = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }
  const v = Number.parseInt(token, 10);
  if (!Number.isFinite(v)) throw new Error(`invalid token: ${token}`);
  if (v < min || v > max) throw new Error(`out-of-range: ${token}`);
  return [v];
}

export function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error('cron expression must be a string');
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields (got ${fields.length}): ${expr}`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((f, i) =>
    expandField(f, FIELD_BOUNDS[i])
  );
  return { minute, hour, dayOfMonth, month, dayOfWeek, raw: expr.trim() };
}

export function validateCron(expr) {
  try {
    parseCron(expr);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function fieldMatches(value, allowed) {
  return allowed.includes(value);
}

// Whether a given Date matches a cron schedule (in local time of the date).
export function cronMatches(cron, date) {
  const min = date.getMinutes();
  const hr = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay();
  if (!fieldMatches(min, cron.minute)) return false;
  if (!fieldMatches(hr, cron.hour)) return false;
  if (!fieldMatches(mon, cron.month)) return false;
  // Standard cron: when both DOM and DOW are restricted, EITHER matches.
  // When one is `*`, only the other constrains.
  const domStar = cron.dayOfMonth.length === 31;
  const dowStar = cron.dayOfWeek.length === 7;
  if (domStar && dowStar) return true;
  if (domStar) return fieldMatches(dow, cron.dayOfWeek);
  if (dowStar) return fieldMatches(dom, cron.dayOfMonth);
  return fieldMatches(dom, cron.dayOfMonth) || fieldMatches(dow, cron.dayOfWeek);
}

// Return the next Date >= `from` (exclusive) where the cron matches.
// Iterates minute-by-minute up to a year ahead. Sufficient for v1.
export function cronNext(cron, from) {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const max = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (d <= max) {
    if (cronMatches(cron, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// Return the most recent Date <= `from` (inclusive) where the cron matches.
// Bounded by a year backward.
export function cronPrev(cron, from) {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  const min = new Date(from.getTime() - 366 * 24 * 60 * 60 * 1000);
  while (d >= min) {
    if (cronMatches(cron, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() - 1);
  }
  return null;
}

// Approximate "expected interval" in milliseconds — used to decide whether
// a missed run warrants catch-up. Returns the smallest gap between two
// consecutive fires, sampled across 14 days starting at `from`.
export function expectedIntervalMs(cron, from = new Date()) {
  let cursor = cronNext(cron, from);
  if (!cursor) return Infinity;
  let smallest = Infinity;
  const horizon = new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000);
  let next = cronNext(cron, cursor);
  let safety = 200;
  while (next && next < horizon && safety-- > 0) {
    smallest = Math.min(smallest, next.getTime() - cursor.getTime());
    cursor = next;
    next = cronNext(cron, cursor);
  }
  return smallest;
}

// Active-window membership. Both calendars (date + window) interpreted as
// local-time dates (no timezone conversion here; cron runs OS-local).
//
// MM-DD recurring: handles wraparound (e.g., Oct 1 → Apr 30).
// YYYY-MM-DD absolute: simple inclusive range.
export function inActiveWindow(active, date) {
  if (!active) return true;
  if (active.from_month_day && active.to_month_day) {
    const [fm, fd] = active.from_month_day.split('-').map(Number);
    const [tm, td] = active.to_month_day.split('-').map(Number);
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const cur = m * 100 + d;
    const lo = fm * 100 + fd;
    const hi = tm * 100 + td;
    if (lo <= hi) return cur >= lo && cur <= hi;
    // wraparound (e.g., 10-01 to 04-30)
    return cur >= lo || cur <= hi;
  }
  if (active.from && active.to) {
    const cur = date.toISOString().slice(0, 10);
    return cur >= active.from && cur <= active.to;
  }
  return true;
}
