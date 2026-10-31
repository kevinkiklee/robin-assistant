import type { RobinDb } from '../../memory/db.ts';
import { DAY_MS, type MetricDef } from './readers.ts';
import {
  compare,
  type PredictionSpec,
  parseStoredSpec,
  specAtEndMs,
  validateSpec,
} from './spec.ts';

/**
 * Deterministic prediction resolver (design docs/design/2026-10-03-prediction-specs.md).
 * Runs in the dream pass BEFORE the unverifiable sweep: every open prediction
 * carrying a `spec` whose `at` has passed is read against Robin's own events and
 * resolved right/wrong with `resolution_source = 'auto:<source>'`.
 *
 * A reader returning null (stream dead, datum stale, account ambiguous) leaves
 * the row open — the next nightly run retries, since late-arriving data (a WHOOP
 * re-sync, a Plaid catch-up) is common. Only after `GRACE_DAYS` past `at` with
 * still no reading is the row closed as 'unverifiable' with an explicit
 * no-data reason, so a spec'd prediction can't sit open forever.
 */

export const GRACE_DAYS = 7;

export interface SpecReading {
  value: number;
  /** Freshest datum (series) or stream heartbeat (window/state), epoch ms. */
  asOf: number;
  /** Points aggregated (series); 1 for window/state readings. */
  n: number;
}

/** Evaluate one spec at `atEndMs`. Null = no trustworthy reading. */
export function readSpec(
  db: RobinDb,
  spec: PredictionSpec,
  metric: MetricDef,
  atEndMs: number,
): SpecReading | null {
  const staleCut = atEndMs - metric.maxStaleDays * DAY_MS;
  if (metric.kind === 'state') {
    const r = metric.read(db, { key: spec.key, atEndMs });
    return r ? { value: r.value, asOf: r.asOf, n: 1 } : null;
  }
  if (metric.kind === 'window') {
    const r = metric.read(db, { key: spec.key, atEndMs, windowDays: spec.window_days ?? 1 });
    if (!r || r.asOf < staleCut) return null;
    return { value: r.value, asOf: r.asOf, n: 1 };
  }
  const agg = spec.agg ?? 'value';
  const fromMs = agg === 'value' ? staleCut : atEndMs - (spec.window_days ?? 1) * DAY_MS + 1;
  const pts = metric
    .points(db, { key: spec.key, fromMs, toMs: atEndMs })
    .filter((p) => p.t >= fromMs && p.t <= atEndMs && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) return null;
  const freshest = pts[pts.length - 1];
  if (freshest.t < staleCut) return null;
  const vals = pts.map((p) => p.v);
  let value: number;
  switch (agg) {
    case 'value':
      value = freshest.v;
      break;
    case 'mean':
      value = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
      break;
    case 'min':
      value = Math.min(...vals);
      break;
    case 'max':
      value = Math.max(...vals);
      break;
    case 'sum':
      value = Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100;
      break;
  }
  return { value, asOf: freshest.t, n: agg === 'value' ? 1 : vals.length };
}

export function describeSpec(spec: PredictionSpec): string {
  const agg = spec.agg && spec.agg !== 'value' ? `${spec.agg}(${spec.window_days}d) ` : '';
  const win = !spec.agg && spec.window_days ? `[${spec.window_days}d] ` : '';
  const key = spec.key ? `[${spec.key}]` : '';
  return `${agg}${win}${spec.source}.${spec.metric}${key} ${spec.op} ${spec.threshold}`;
}

export interface ResolveSpecReport {
  /** Open spec'd predictions examined. */
  considered: number;
  right: number;
  wrong: number;
  /** `at` not yet passed. */
  notDue: number;
  /** Due, but no trustworthy reading yet (left open, retried next run). */
  noData: number;
  /** Closed 'unverifiable' after GRACE_DAYS with no reading or an invalid spec. */
  expired: number;
}

interface OpenRow {
  id: number;
  confidence: number;
  deadline: string | null;
  spec: string;
}

export function resolveSpecPredictions(
  db: RobinDb,
  now: Date = new Date(),
  opts: { graceDays?: number } = {},
): ResolveSpecReport {
  const graceMs = (opts.graceDays ?? GRACE_DAYS) * DAY_MS;
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const report: ResolveSpecReport = {
    considered: 0,
    right: 0,
    wrong: 0,
    notDue: 0,
    noData: 0,
    expired: 0,
  };
  const open = db
    .prepare(
      `SELECT id, confidence, deadline, spec FROM predictions WHERE outcome IS NULL AND spec IS NOT NULL`,
    )
    .all() as OpenRow[];
  const update = db.prepare(
    `UPDATE predictions SET outcome = ?, resolved_at = ?, evidence = ?, brier_delta = ?, resolution_source = ?
     WHERE id = ? AND outcome IS NULL`,
  );

  for (const row of open) {
    report.considered++;
    const v = validateSpec(parseStoredSpec(row.spec), row.deadline);
    if (!v.ok) {
      const dl = specAtEndMs(row.deadline);
      if (dl !== null && nowMs > dl + graceMs) {
        update.run(
          'unverifiable',
          nowIso,
          `Auto-resolved as unverifiable at ${nowIso}: stored spec is invalid (${v.error}) and the deadline passed ${opts.graceDays ?? GRACE_DAYS}d ago.`,
          null,
          'auto:invalid-spec',
          row.id,
        );
        report.expired++;
      } else {
        report.noData++;
      }
      continue;
    }
    const { spec, metric } = v;
    const atEnd = specAtEndMs(spec.at ?? row.deadline) as number;
    if (nowMs <= atEnd) {
      report.notDue++;
      continue;
    }
    const reading = readSpec(db, spec, metric, atEnd);
    const atIso = new Date(atEnd).toISOString();
    if (!reading) {
      if (nowMs > atEnd + graceMs) {
        update.run(
          'unverifiable',
          nowIso,
          `Auto-resolved as unverifiable at ${nowIso}: spec ${describeSpec(spec)} @ ${atIso} — ` +
            `no fresh ${spec.source} reading within ${opts.graceDays ?? GRACE_DAYS}d after \`at\` ` +
            `(stream stale/dead, or key matched no single series).`,
          null,
          `auto:${spec.source}:no-data`,
          row.id,
        );
        report.expired++;
      } else {
        report.noData++;
      }
      continue;
    }
    const truth = compare(reading.value, spec.op, spec.threshold);
    const outcome = truth ? 'right' : 'wrong';
    const brier = (row.confidence - (truth ? 1 : 0)) ** 2;
    update.run(
      outcome,
      nowIso,
      `Auto-resolved by spec at ${nowIso}: ${describeSpec(spec)} @ ${atIso} → reading ` +
        `${reading.value} (n=${reading.n}, as of ${new Date(reading.asOf).toISOString()}) → claim ${truth}.`,
      brier,
      `auto:${spec.source}`,
      row.id,
    );
    if (truth) report.right++;
    else report.wrong++;
  }
  return report;
}
