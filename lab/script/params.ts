export interface RatesRow {
  metric: string;
  [k: string]: unknown;
}

export interface ScriptParams {
  horizonDays: number;
  startDate: string;
  perYear: { trips: number; gear: number; preferences: number; routines: number };
  disclosureSessionsPerDay: number; // cap; extra disclosures share sessions
  fillerPerDay: number;
  clarity: { explicit: number; hedged: number; implied: number };
  lag: { sameDay: number; withinWeek: number; never: number }; // remainder: 8–30 days
  docShare: number; // share of trip disclosures that go to a decision doc
  baitShare: number;
  reverseShare: number;
  reassertShare: number;
  assistant: { callRate: number; omitted: number; sloppyTopic: number; wrongValue: number };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

function cloneParams(p: ScriptParams): ScriptParams {
  return structuredClone(p);
}

export const DEFAULT_PARAMS: ScriptParams = deepFreeze({
  horizonDays: 90,
  startDate: '2027-01-04',
  perYear: { trips: 30, gear: 120, preferences: 60, routines: 15 },
  disclosureSessionsPerDay: 4,
  fillerPerDay: 2,
  clarity: { explicit: 0.7, hedged: 0.2, implied: 0.1 },
  lag: { sameDay: 0.6, withinWeek: 0.25, never: 0.05 },
  docShare: 0.3,
  baitShare: 0.1,
  reverseShare: 0.15,
  reassertShare: 0.1,
  assistant: { callRate: 0.5, omitted: 0.2, sloppyTopic: 0.1, wrongValue: 0.05 },
} satisfies ScriptParams);

export function paramsWith(over: Partial<ScriptParams>): ScriptParams {
  return cloneParams({ ...DEFAULT_PARAMS, ...over });
}

/** Map the operator's aggregate calibration rows (lab/calibrate/rates.sql) onto params. */
export function paramsFromRates(rates: RatesRow[], over: Partial<ScriptParams> = {}): ScriptParams {
  const num = (metric: string, col: string): number | null => {
    const row = rates.find((r) => r.metric === metric);
    const v = row?.[col];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const p: ScriptParams = cloneParams(DEFAULT_PARAMS);
  const perDay = num('sessions_per_day', 'per_day');
  const filler = num('filler_session_share', 'share');
  if (perDay !== null && filler !== null) {
    p.fillerPerDay = Math.round(perDay * filler);
    p.disclosureSessionsPerDay = Math.max(1, Math.round(perDay - p.fillerPerDay));
  }
  return cloneParams({ ...p, ...over });
}
