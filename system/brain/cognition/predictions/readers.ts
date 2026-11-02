import type { RobinDb } from '../../memory/db.ts';

/**
 * Deterministic metric readers over Robin's own events table — the data the
 * prediction resolver checks a `spec` against (design
 * docs/design/2026-10-03-prediction-specs.md). Pure reads, no LLM, no I/O
 * beyond the db handle.
 *
 * Two metric shapes:
 *  - `series`: dated point values (a recovery score per morning, a balance per
 *    snapshot day). The resolver aggregates them (`value` = latest as of `at`,
 *    or mean/min/max/sum over `window_days`).
 *  - `window`: a quantity only defined over a window (workouts logged, frames
 *    imported). The reader computes it directly for `window_days` ending at `at`.
 *
 * Every metric carries `maxStaleDays`: a reading whose freshest datum (series)
 * or stream heartbeat (window) is older than that before `at` returns null —
 * a dead stream must leave the prediction open, never resolve it on stale data.
 */

export const DAY_MS = 86_400_000;

export interface Point {
  /** Measurement time (epoch ms) — payload time, not ingest time, where one exists. */
  t: number;
  v: number;
}

export interface SeriesQuery {
  key?: string;
  /** Inclusive bounds (epoch ms) on the measurement time. */
  fromMs: number;
  toMs: number;
}

export interface WindowQuery {
  key?: string;
  /** Window end (epoch ms, inclusive). */
  atEndMs: number;
  windowDays: number;
}

export interface WindowReading {
  value: number;
  /** Stream heartbeat (epoch ms) — freshest event of the underlying stream. */
  asOf: number;
}

interface MetricBase {
  description: string;
  /** Required `key` (account, symbol, issue id, …) and what it means. */
  key?: string;
  /** Optional key (filters when present). */
  optionalKey?: string;
  maxStaleDays: number;
}

export interface SeriesMetric extends MetricBase {
  kind: 'series';
  points: (db: RobinDb, q: SeriesQuery) => Point[];
}

export interface WindowMetric extends MetricBase {
  kind: 'window';
  read: (db: RobinDb, q: WindowQuery) => WindowReading | null;
}

/** Point-in-time state as of `at` (no window): Linear issue states. */
export interface StateMetric extends MetricBase {
  kind: 'state';
  read: (db: RobinDb, q: Omit<WindowQuery, 'windowDays'>) => WindowReading | null;
}

export type MetricDef = SeriesMetric | WindowMetric | StateMetric;

// ---------------------------------------------------------------------------
// helpers

interface Row {
  id: number;
  ts: string;
  p: Record<string, unknown>;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function time(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Events of `kinds` ingested at or after `sinceMs`, oldest first. */
function rows(db: RobinDb, kinds: string[], sinceMs: number | null): Row[] {
  const ph = kinds.map(() => '?').join(',');
  const sql =
    sinceMs === null
      ? `SELECT id, ts, payload FROM events WHERE kind IN (${ph}) ORDER BY id`
      : `SELECT id, ts, payload FROM events WHERE kind IN (${ph}) AND ts >= ? ORDER BY id`;
  const args: unknown[] = sinceMs === null ? kinds : [...kinds, iso(sinceMs)];
  const out = db.prepare(sql).all(...args) as Array<{ id: number; ts: string; payload: string }>;
  return out.map((r) => {
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      /* unparseable payload → empty */
    }
    return { id: r.id, ts: r.ts, p };
  });
}

/** Latest row per payload.external_id (re-syncs re-ingest the same measurement). */
function latestByExternalId(list: Row[]): Row[] {
  const by = new Map<string, Row>();
  for (const r of list) {
    const k = typeof r.p.external_id === 'string' ? r.p.external_id : `id:${r.id}`;
    const cur = by.get(k);
    if (!cur || r.id > cur.id) by.set(k, r);
  }
  return [...by.values()];
}

function heartbeat(db: RobinDb, kinds: string[]): number | null {
  const ph = kinds.map(() => '?').join(',');
  const row = db.prepare(`SELECT MAX(ts) AS t FROM events WHERE kind IN (${ph})`).get(...kinds) as {
    t: string | null;
  };
  return time(row.t);
}

const inRange = (t: number, q: SeriesQuery) => t >= q.fromMs && t <= q.toMs;

/** Ingest `ts` is never before measurement time, so `fromMs` bounds the scan safely. */
const SCAN_SLACK_MS = DAY_MS;

// ---------------------------------------------------------------------------
// whoop

function whoopSeries(
  kind: 'whoop.recovery' | 'whoop.sleep' | 'whoop.cycle',
  at: (p: Record<string, unknown>) => number | null,
  value: (p: Record<string, unknown>) => number | null,
): SeriesMetric['points'] {
  return (db, q) => {
    const out: Point[] = [];
    for (const r of latestByExternalId(rows(db, [kind], q.fromMs - SCAN_SLACK_MS))) {
      const p = r.p;
      if (p.provisional === true) continue;
      if (typeof p.score_state === 'string' && p.score_state !== 'SCORED') continue;
      if (p.nap === true) continue;
      const t = at(p);
      const v = value(p);
      if (t === null || v === null || !inRange(t, q)) continue;
      out.push({ t, v });
    }
    return out;
  };
}

const score = (p: Record<string, unknown>) => (p.score ?? {}) as Record<string, unknown>;
const recovery = (f: (s: Record<string, unknown>) => number | null): SeriesMetric => ({
  kind: 'series',
  description: '',
  maxStaleDays: 2,
  // created_at = sleep-end (the morning the score finalized), stable across re-syncs.
  points: whoopSeries(
    'whoop.recovery',
    (p) => time(p.created_at),
    (p) => f(score(p)),
  ),
});
const sleep = (f: (s: Record<string, unknown>) => number | null): SeriesMetric => ({
  kind: 'series',
  description: '',
  maxStaleDays: 2,
  points: whoopSeries(
    'whoop.sleep',
    (p) => time(p.end),
    (p) => f(score(p)),
  ),
});

const WHOOP: Record<string, MetricDef> = {
  recovery_score: {
    ...recovery((s) => num(s.recovery_score)),
    description: 'WHOOP recovery % per finalized morning',
  },
  hrv: { ...recovery((s) => num(s.hrv_rmssd_milli)), description: 'HRV rMSSD (ms) per morning' },
  rhr: { ...recovery((s) => num(s.resting_heart_rate)), description: 'resting heart rate (bpm)' },
  sleep_performance: {
    ...sleep((s) => num(s.sleep_performance_percentage)),
    description: 'sleep performance % per night (naps excluded)',
  },
  sleep_efficiency: {
    ...sleep((s) => num(s.sleep_efficiency_percentage)),
    description: 'sleep efficiency % per night',
  },
  sleep_hours: {
    ...sleep((s) => {
      const st = (s.stage_summary ?? {}) as Record<string, unknown>;
      const bed = num(st.total_in_bed_time_milli);
      const awake = num(st.total_awake_time_milli) ?? 0;
      return bed === null ? null : Math.round(((bed - awake) / 3_600_000) * 100) / 100;
    }),
    description: 'hours asleep per night (in bed minus awake)',
  },
  strain: {
    kind: 'series',
    description: 'day strain per COMPLETED cycle (the in-progress cycle is excluded)',
    maxStaleDays: 2,
    points: whoopSeries(
      'whoop.cycle',
      (p) => (p.end ? time(p.start) : null),
      (p) => num(score(p).strain),
    ),
  },
  workouts: {
    kind: 'window',
    description: 'count of WHOOP workouts started in the window',
    optionalKey: 'sport_name filter, e.g. "weightlifting" (case-insensitive)',
    maxStaleDays: 2,
    read: (db, q) => {
      const hb = heartbeat(db, ['whoop.recovery', 'whoop.sleep', 'whoop.cycle', 'whoop.workout']);
      if (hb === null) return null;
      const from = q.atEndMs - q.windowDays * DAY_MS;
      const want = q.key?.trim().toLowerCase();
      let n = 0;
      for (const r of latestByExternalId(rows(db, ['whoop.workout'], from - SCAN_SLACK_MS))) {
        const t = time(r.p.start);
        if (t === null || t <= from || t > q.atEndMs) continue;
        if (want && String(r.p.sport_name ?? '').toLowerCase() !== want) continue;
        n += 1;
      }
      return { value: n, asOf: hb };
    },
  },
};

// ---------------------------------------------------------------------------
// finance

const LIABILITY_TYPES = new Set(['credit', 'loan']);
const SNAPSHOT = 'lunch_money.account_snapshot';
const snapshotTime = (p: Record<string, unknown>) =>
  typeof p.snapshot_date === 'string'
    ? time(`${p.snapshot_date.slice(0, 10)}T12:00:00.000Z`)
    : null;

/**
 * Daily account snapshots in range (by snapshot day). `t` is when the balance
 * was actually true: the snapshot day, or — for a snapshot the integration
 * flagged `stale` (Plaid lagging, e.g. an account 13 days behind) — the account's
 * `balance_last_update`, so a single-account read applies the freshness bound
 * to the real balance date. Day sums (net worth, cash) still count stale
 * accounts at their last-known balance rather than silently dropping them.
 */
function snapshots(db: RobinDb, q: SeriesQuery): Array<Row & { day: number; t: number }> {
  const out: Array<Row & { day: number; t: number }> = [];
  for (const r of latestByExternalId(rows(db, [SNAPSHOT], q.fromMs - SCAN_SLACK_MS))) {
    const day = snapshotTime(r.p);
    if (day === null || !inRange(day, q) || num(r.p.balance) === null) continue;
    const t = r.p.stale === true ? (time(r.p.balance_last_update) ?? 0) : day;
    out.push({ ...r, day, t });
  }
  return out;
}

/**
 * Same exclusion as the brief's spend trend (user-data jobs/_shared/trends.ts):
 * card payments and transfers are not consumption.
 */
export function isTransferOrPayment(meta: Record<string, unknown>): boolean {
  const category = typeof meta.category === 'string' ? meta.category.toLowerCase() : '';
  if (category.includes('transfer')) return true;
  const hay = `${meta.payee ?? ''} ${meta.original_name ?? ''}`.toLowerCase();
  return /payment to .*card|payment thank you|plan contribution/.test(hay);
}

/** Sum of per-account balances per snapshot day; only days where every account reported. */
function balanceSums(
  db: RobinDb,
  q: SeriesQuery,
  include: (type: string) => number, // +1 asset, -1 liability, 0 skip
): Point[] {
  const snaps = snapshots(db, { ...q, fromMs: q.fromMs - 7 * DAY_MS });
  const accounts = new Set(snaps.map((s) => s.p.lm_id));
  const byDay = new Map<number, { sum: number; seen: Set<unknown> }>();
  for (const s of snaps) {
    const sign = include(String(s.p.type ?? ''));
    const cur = byDay.get(s.day) ?? { sum: 0, seen: new Set() };
    cur.seen.add(s.p.lm_id);
    cur.sum += sign * (num(s.p.balance) ?? 0);
    byDay.set(s.day, cur);
  }
  const out: Point[] = [];
  for (const [t, d] of byDay) {
    if (!inRange(t, q) || d.seen.size < accounts.size) continue; // partial day → skip
    out.push({ t, v: Math.round(d.sum * 100) / 100 });
  }
  return out;
}

const FINANCE: Record<string, MetricDef> = {
  balance: {
    kind: 'series',
    description: 'one account balance per snapshot day (credit = amount owed)',
    key: 'account display name — exact (case-insensitive) or a unique substring, e.g. "Savings"',
    maxStaleDays: 3,
    points: (db, q) => {
      const want = (q.key ?? '').trim().toLowerCase();
      if (!want) return [];
      const snaps = snapshots(db, q);
      const names = new Map<unknown, string>();
      for (const s of snaps) names.set(s.p.lm_id, String(s.p.display_name ?? '').toLowerCase());
      const exact = [...names].filter(([, n]) => n === want).map(([id]) => id);
      const partial = [...names].filter(([, n]) => n.includes(want)).map(([id]) => id);
      const ids = exact.length > 0 ? exact : partial;
      if (ids.length !== 1) return []; // unknown or ambiguous account → no reading
      // A lagging account repeats one stale balance across snapshot days — one point per real date.
      const byT = new Map<number, number>();
      for (const s of snaps) if (s.p.lm_id === ids[0]) byT.set(s.t, num(s.p.balance) ?? 0);
      return [...byT].map(([t, v]) => ({ t, v }));
    },
  },
  net_worth: {
    kind: 'series',
    description: 'sum of asset balances minus credit/loan balances per snapshot day',
    maxStaleDays: 3,
    points: (db, q) => balanceSums(db, q, (type) => (LIABILITY_TYPES.has(type) ? -1 : 1)),
  },
  cash: {
    kind: 'series',
    description: 'sum of depository (checking + savings) balances per snapshot day',
    maxStaleDays: 3,
    points: (db, q) => balanceSums(db, q, (type) => (type === 'depository' ? 1 : 0)),
  },
  spend_per_day: {
    kind: 'series',
    description:
      'total discretionary outflow per day with spending (transfers/card payments excluded); agg "mean" + window_days 7/30 reproduces the brief\'s finance.spend_per_day d7/d30',
    maxStaleDays: 4,
    points: (db, q) => {
      const byDay = new Map<string, number>();
      for (const r of latestByExternalId(
        rows(db, ['lunch_money.transaction'], q.fromMs - SCAN_SLACK_MS),
      )) {
        const m = r.p;
        if (m.is_income === true || m.deleted === true || isTransferOrPayment(m)) continue;
        const amount = num(m.amount);
        if (amount === null || amount <= 0) continue;
        const day = typeof m.date === 'string' ? m.date.slice(0, 10) : r.ts.slice(0, 10);
        byDay.set(day, (byDay.get(day) ?? 0) + amount);
      }
      const out: Point[] = [];
      for (const [day, v] of byDay) {
        const t = Date.parse(`${day}T12:00:00.000Z`);
        if (inRange(t, q)) out.push({ t, v: Math.round(v * 100) / 100 });
      }
      return out;
    },
  },
  quote_price: {
    kind: 'series',
    description: 'market quote price per tick',
    key: 'ticker symbol, e.g. "SPY"',
    maxStaleDays: 4,
    points: (db, q) => quotePoints(db, q, 'price'),
  },
  quote_change_pct: {
    kind: 'series',
    description: 'daily % change per quote tick',
    key: 'ticker symbol',
    maxStaleDays: 4,
    points: (db, q) => quotePoints(db, q, 'change_pct'),
  },
};

function quotePoints(db: RobinDb, q: SeriesQuery, field: 'price' | 'change_pct'): Point[] {
  const sym = (q.key ?? '').trim().toUpperCase();
  const out: Point[] = [];
  for (const r of rows(db, ['integration.finance_quote.tick'], q.fromMs)) {
    if (String(r.p.symbol ?? '').toUpperCase() !== sym) continue;
    const t = time(r.ts);
    const v = num(r.p[field]);
    if (t !== null && v !== null && inRange(t, q)) out.push({ t, v });
  }
  return out;
}

// ---------------------------------------------------------------------------
// photos (Lightroom catalog summary — the live photography clock)

const LRC = 'lrc.catalog_summary';

const PHOTOS: Record<string, MetricDef> = {
  total_photos: {
    kind: 'series',
    description: 'Lightroom catalog total photo count per daily snapshot',
    maxStaleDays: 3,
    points: (db, q) =>
      rows(db, [LRC], q.fromMs)
        .map((r) => ({ t: time(r.ts) ?? Number.NaN, v: num(r.p.total_photos) ?? Number.NaN }))
        .filter((pt) => Number.isFinite(pt.v) && inRange(pt.t, q)),
  },
  rated_count: {
    kind: 'series',
    description: 'catalog photos at an exact star rating per snapshot',
    key: 'star rating "0".."5"',
    maxStaleDays: 3,
    points: (db, q) =>
      rows(db, [LRC], q.fromMs)
        .map((r) => {
          const ratings = (r.p.ratings ?? {}) as Record<string, unknown>;
          return {
            t: time(r.ts) ?? Number.NaN,
            v: num(ratings[String(q.key ?? '').trim()]) ?? Number.NaN,
          };
        })
        .filter((pt) => Number.isFinite(pt.v) && inRange(pt.t, q)),
  },
  days_since_import: {
    kind: 'series',
    description: 'days since the last Lightroom import, per snapshot',
    maxStaleDays: 3,
    points: (db, q) =>
      rows(db, [LRC], q.fromMs)
        .map((r) => {
          const t = time(r.ts) ?? Number.NaN;
          const last = time(r.p.last_import_date);
          return { t, v: last === null ? Number.NaN : Math.floor((t - last) / DAY_MS) };
        })
        .filter((pt) => Number.isFinite(pt.v) && inRange(pt.t, q)),
  },
  frames_added: {
    kind: 'window',
    description:
      'gross frames imported in the window (sum of positive day-over-day total_photos deltas; culls ignored)',
    maxStaleDays: 3,
    read: (db, q) => {
      const from = q.atEndMs - q.windowDays * DAY_MS;
      // One snapshot before the window anchors the first delta.
      const list = rows(db, [LRC], from - 3 * DAY_MS)
        .map((r) => ({ t: time(r.ts) ?? Number.NaN, v: num(r.p.total_photos) }))
        .filter((r) => Number.isFinite(r.t) && r.v !== null && r.t <= q.atEndMs) as Point[];
      if (list.length < 2) return null;
      let added = 0;
      for (let i = 1; i < list.length; i += 1) {
        if (list[i].t <= from) continue;
        const d = list[i].v - list[i - 1].v;
        if (d > 0) added += d;
      }
      return { value: added, asOf: list[list.length - 1].t };
    },
  },
  critiques: {
    kind: 'window',
    description: 'count of per-photo critiques (photos.critique) written in the window',
    maxStaleDays: 7,
    read: (db, q) => {
      const hb = heartbeat(db, ['photos.critique', 'photos.nightly_critique']);
      if (hb === null) return null;
      const from = q.atEndMs - q.windowDays * DAY_MS;
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM events WHERE kind = 'photos.critique' AND ts > ? AND ts <= ?`,
        )
        .get(iso(from), iso(q.atEndMs)) as { n: number };
      return { value: row.n, asOf: hb };
    },
  },
};

// ---------------------------------------------------------------------------
// linear — events are emitted on change (one per updatedAt), so the latest event
// at or before `at` IS the state at `at`; no freshness bound applies.

const CLOSED_TYPES = new Set(['completed', 'canceled']);

function linearStates(db: RobinDb, atEndMs: number): Map<string, Record<string, unknown>> {
  const latest = new Map<string, { t: number; p: Record<string, unknown> }>();
  for (const r of rows(db, ['integration.linear.issue'], null)) {
    const id = typeof r.p.identifier === 'string' ? r.p.identifier.toUpperCase() : null;
    const t = time(r.p.updatedAt) ?? time(r.ts);
    if (!id || t === null || t > atEndMs) continue;
    const cur = latest.get(id);
    if (!cur || t >= cur.t) latest.set(id, { t, p: r.p });
  }
  return new Map([...latest].map(([k, v]) => [k, v.p]));
}

const linearState = (
  f: (states: Map<string, Record<string, unknown>>, key: string) => number | null,
): StateMetric['read'] => {
  return (db, q) => {
    const states = linearStates(db, q.atEndMs);
    const v = f(states, (q.key ?? '').trim());
    return v === null ? null : { value: v, asOf: q.atEndMs };
  };
};

const LINEAR: Record<string, MetricDef> = {
  issue_open: {
    kind: 'state',
    description: '1 if the issue is open (not completed/canceled) at `at`, else 0',
    key: 'issue identifier, e.g. "ENG-12"',
    maxStaleDays: Number.POSITIVE_INFINITY,
    read: linearState((s, key) => {
      const p = s.get(key.toUpperCase());
      return p ? (CLOSED_TYPES.has(String(p.state_type)) ? 0 : 1) : null;
    }),
  },
  issue_in_backlog: {
    kind: 'state',
    description: '1 if the issue is still in a backlog state at `at`, else 0',
    key: 'issue identifier, e.g. "ENG-12"',
    maxStaleDays: Number.POSITIVE_INFINITY,
    read: linearState((s, key) => {
      const p = s.get(key.toUpperCase());
      return p ? (String(p.state_type) === 'backlog' ? 1 : 0) : null;
    }),
  },
  open_issues: {
    kind: 'state',
    description: 'count of issues open (not completed/canceled) at `at`',
    optionalKey: 'team key filter, e.g. "ENG"',
    maxStaleDays: Number.POSITIVE_INFINITY,
    read: linearState((s, key) => {
      if (s.size === 0) return null;
      let n = 0;
      for (const p of s.values()) {
        if (key && String(p.team ?? '').toUpperCase() !== key.toUpperCase()) continue;
        if (!CLOSED_TYPES.has(String(p.state_type))) n += 1;
      }
      return n;
    }),
  },
  state_count: {
    kind: 'state',
    description: 'count of issues whose state name (or state type) matches `key` at `at`',
    key: 'state name or type, e.g. "Backlog", "In Progress", "completed"',
    maxStaleDays: Number.POSITIVE_INFINITY,
    read: linearState((s, key) => {
      if (s.size === 0) return null;
      const want = key.toLowerCase();
      let n = 0;
      for (const p of s.values()) {
        if (String(p.state ?? '').toLowerCase() === want || String(p.state_type ?? '') === want)
          n += 1;
      }
      return n;
    }),
  },
};

/** source → metric → reader. Add a source here and it becomes spec-able everywhere. */
export const METRIC_REGISTRY: Record<string, Record<string, MetricDef>> = {
  whoop: WHOOP,
  finance: FINANCE,
  photos: PHOTOS,
  linear: LINEAR,
};

export function getMetric(source: string, metric: string): MetricDef | null {
  return METRIC_REGISTRY[source]?.[metric] ?? null;
}

/**
 * One-line-per-source catalog for tool descriptions (token-cheap):
 * `whoop: recovery_score, …, workouts~ | finance: balance(key), …`.
 * `(key)` = key required, `~` = windowed (window_days required), `@` = point-in-time state.
 */
export function compactRegistry(): string {
  return Object.entries(METRIC_REGISTRY)
    .map(
      ([source, metrics]) =>
        `${source}: ${Object.entries(metrics)
          .map(
            ([n, m]) =>
              `${n}${m.key ? '(key)' : ''}${m.kind === 'window' ? '~' : m.kind === 'state' ? '@' : ''}`,
          )
          .join(', ')}`,
    )
    .join(' | ');
}

/** Full catalog for prompts/docs: `source.metric [key: …] (shape) — description`. */
export function describeRegistry(): string {
  const lines: string[] = [];
  for (const [source, metrics] of Object.entries(METRIC_REGISTRY)) {
    for (const [name, m] of Object.entries(metrics)) {
      const key = m.key
        ? ` [key REQUIRED: ${m.key}]`
        : m.optionalKey
          ? ` [key optional: ${m.optionalKey}]`
          : '';
      const shape =
        m.kind === 'window'
          ? ' (windowed: window_days REQUIRED, no agg)'
          : m.kind === 'state'
            ? ' (state at `at`: no agg, no window_days)'
            : ' (series: agg value|mean|min|max|sum; non-value agg needs window_days)';
      lines.push(`- ${source}.${name}${key}${shape} — ${m.description}`);
    }
  }
  return lines.join('\n');
}
