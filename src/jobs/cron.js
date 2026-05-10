// src/jobs/cron.js — minimal 5-field cron + @-aliases.
const ALIASES = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6], // 0 = Sunday
};

const ITER_CAP = 5_000_000; // ~10 years of minutes

function parseField(name, raw) {
  const [lo, hi] = RANGES[name];
  if (raw === '*') return '*';
  const out = new Set();
  for (const part of raw.split(',')) {
    let step = 1;
    let body = part;
    if (body.includes('/')) {
      const [b, s] = body.split('/');
      body = b;
      step = Number.parseInt(s, 10);
      if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in ${name}: ${raw}`);
    }
    let a;
    let b;
    if (body === '*') {
      a = lo;
      b = hi;
    } else if (body.includes('-')) {
      const [s, e] = body.split('-').map((x) => Number.parseInt(x, 10));
      a = s;
      b = e;
    } else {
      a = Number.parseInt(body, 10);
      b = a;
    }
    if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`invalid ${name}: ${raw}`);
    if (a < lo || b > hi) throw new Error(`${name} out of range [${lo},${hi}]: ${raw}`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

export function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error('invalid cron: not a string');
  const trimmed = expr.trim();
  const encoded = ALIASES[trimmed] ?? trimmed;
  const fields = encoded.split(/\s+/);
  if (fields.length !== 5) throw new Error(`invalid cron (need 5 fields): ${expr}`);
  const [m, h, d, mo, dw] = fields;
  return {
    encoded,
    minute: parseField('minute', m),
    hour: parseField('hour', h),
    dom: parseField('dom', d),
    month: parseField('month', mo),
    dow: parseField('dow', dw),
  };
}

function matchField(parsed, value) {
  return parsed === '*' || parsed.includes(value);
}

function matches(parts, date) {
  return (
    matchField(parts.minute, date.getMinutes()) &&
    matchField(parts.hour, date.getHours()) &&
    matchField(parts.month, date.getMonth() + 1) &&
    // DOM/DOW union: if both fields are *, match. If either is restricted, OR them.
    ((parts.dom === '*' && parts.dow === '*') ||
      (parts.dom !== '*' && matchField(parts.dom, date.getDate())) ||
      (parts.dow !== '*' && matchField(parts.dow, date.getDay())))
  );
}

export function nextFire(parts, after) {
  const t = new Date(after);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < ITER_CAP; i += 1) {
    if (matches(parts, t)) return new Date(t);
    t.setMinutes(t.getMinutes() + 1);
  }
  throw new Error(`nextFire exceeded ${ITER_CAP} iterations for ${parts.encoded}`);
}

export function prevFire(parts, before) {
  const t = new Date(before);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() - 1);
  for (let i = 0; i < ITER_CAP; i += 1) {
    if (matches(parts, t)) return new Date(t);
    t.setMinutes(t.getMinutes() - 1);
  }
  throw new Error(`prevFire exceeded ${ITER_CAP} iterations for ${parts.encoded}`);
}

export function expectedIntervalMs(parts, around) {
  const next = nextFire(parts, around);
  const after = nextFire(parts, next);
  return after.getTime() - next.getTime();
}
