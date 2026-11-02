import { z } from 'zod';
import { DAY_MS, getMetric, type MetricDef } from './readers.ts';

/**
 * Structured resolution spec for a prediction (design
 * docs/design/2026-10-03-prediction-specs.md). Stored as JSON in
 * `predictions.spec`; evaluated by resolve-spec.ts once `at` has passed.
 *
 *   { "source": "whoop", "metric": "recovery_score", "op": ">=", "threshold": 65,
 *     "at": "2027-04-14", "agg": "mean", "window_days": 5 }
 *
 * The claim is TRUE ('right') iff `<reading> <op> <threshold>` holds.
 */

export const SPEC_OPS = ['>', '>=', '<', '<=', '==', '!='] as const;
export const SPEC_AGGS = ['value', 'mean', 'min', 'max', 'sum'] as const;

export type SpecOp = (typeof SPEC_OPS)[number];
export type SpecAgg = (typeof SPEC_AGGS)[number];

/** Shape-only schema (MCP input, LLM output). Semantic checks live in validateSpec. */
export const PredictionSpecSchema = z.object({
  source: z.string().describe('Data source: whoop | finance | photos | linear'),
  metric: z.string().describe('Metric name within the source, e.g. recovery_score, balance'),
  op: z.enum(SPEC_OPS).describe('Comparison: the claim is true iff <reading> <op> <threshold>'),
  threshold: z.number().describe('Number the reading is compared against'),
  at: z
    .string()
    .optional()
    .describe(
      'ISO date (YYYY-MM-DD = end of that day UTC) or datetime the reading is taken at / the window ends; defaults to the deadline',
    ),
  key: z
    .string()
    .optional()
    .describe('Metric parameter: account name, ticker, issue id, sport, star rating'),
  agg: z
    .enum(SPEC_AGGS)
    .optional()
    .describe('Series aggregation: value (latest as of at, default) | mean | min | max | sum'),
  window_days: z
    .number()
    .int()
    .min(1)
    .max(366)
    .optional()
    .describe('Window length ending at `at` (required for non-value agg and windowed metrics)'),
});

export type PredictionSpec = z.infer<typeof PredictionSpecSchema>;

export type SpecValidation =
  | { ok: true; spec: PredictionSpec; metric: MetricDef }
  | { ok: false; error: string };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a spec `at` (or the deadline fallback) to the inclusive end of the
 * reading window, epoch ms. Date-only = 23:59:59.999Z that day. Null if unparseable.
 */
export function specAtEndMs(at: string | null | undefined): number | null {
  if (!at) return null;
  const s = at.trim();
  if (DATE_ONLY.test(s)) {
    const t = Date.parse(`${s}T00:00:00.000Z`);
    return Number.isNaN(t) ? null : t + DAY_MS - 1;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * Shape + semantic validation: source/metric exist in the registry, key given
 * when the metric needs one, agg/window_days consistent with the metric kind,
 * and a resolvable `at` (from the spec or the prediction's deadline).
 */
export function validateSpec(input: unknown, deadline?: string | null): SpecValidation {
  const parsed = PredictionSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`)
        .join('; '),
    };
  }
  const spec = parsed.data;
  if (!Number.isFinite(spec.threshold)) return { ok: false, error: 'threshold must be finite' };
  const metric = getMetric(spec.source, spec.metric);
  if (!metric) {
    return { ok: false, error: `unknown metric '${spec.source}.${spec.metric}'` };
  }
  if (metric.key && !spec.key?.trim()) {
    return { ok: false, error: `${spec.source}.${spec.metric} requires key (${metric.key})` };
  }
  if (!metric.key && !metric.optionalKey && spec.key !== undefined) {
    return { ok: false, error: `${spec.source}.${spec.metric} takes no key` };
  }
  const agg = spec.agg ?? 'value';
  if (metric.kind === 'series') {
    if (agg !== 'value' && spec.window_days === undefined) {
      return { ok: false, error: `agg '${agg}' needs window_days` };
    }
    if (agg === 'value' && spec.window_days !== undefined) {
      return { ok: false, error: `window_days only applies with agg mean|min|max|sum` };
    }
  } else {
    if (spec.agg !== undefined && spec.agg !== 'value') {
      return { ok: false, error: `${spec.source}.${spec.metric} is not a series — drop agg` };
    }
    if (metric.kind === 'window' && spec.window_days === undefined) {
      return { ok: false, error: `${spec.source}.${spec.metric} needs window_days` };
    }
    if (metric.kind === 'state' && spec.window_days !== undefined) {
      return {
        ok: false,
        error: `${spec.source}.${spec.metric} is point-in-time — drop window_days`,
      };
    }
  }
  if (spec.at !== undefined && specAtEndMs(spec.at) === null) {
    return { ok: false, error: `at '${spec.at}' is not an ISO date/datetime` };
  }
  if (spec.at === undefined && specAtEndMs(deadline) === null) {
    return { ok: false, error: 'spec needs `at` (or the prediction needs a deadline)' };
  }
  return { ok: true, spec, metric };
}

/** Parse a stored `predictions.spec` JSON value; null on absent/corrupt. */
export function parseStoredSpec(raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function compare(value: number, op: SpecOp, threshold: number): boolean {
  const EPS = 1e-9;
  switch (op) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold - EPS;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold + EPS;
    case '==':
      return Math.abs(value - threshold) <= EPS;
    case '!=':
      return Math.abs(value - threshold) > EPS;
  }
}
