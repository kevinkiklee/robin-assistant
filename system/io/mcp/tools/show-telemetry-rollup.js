// show-telemetry-rollup.js — read-only MCP introspection tool over
// telemetry_hourly. Shadow-mode-aware. Read-only by contract (enforced
// by audit-introspection-readonly.test.js: no SurrealQL write keywords
// permitted in this file).

import { readTelemetryConfig } from '../../../cognition/telemetry/config.js';
import { reshapeTelemetryRollup } from '../../format/telemetry-rollup.js';

const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?)?$/;

function parseWindowMs(window) {
  // Tiny ISO-8601-duration parser for "PT24H", "P7D", "P1D", etc.
  // Reject anything else; default 24h.
  if (typeof window !== 'string') return 24 * 3_600_000;
  const m = window.match(ISO_DURATION);
  if (!m) return 24 * 3_600_000;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const ms = (days * 24 + hours) * 3_600_000;
  return ms > 0 ? ms : 24 * 3_600_000;
}

export function createShowTelemetryRollupTool({ db }) {
  return {
    name: 'show_telemetry_rollup',
    description:
      'Return hourly telemetry rollups. Filter by faculty and/or event_kind. ' +
      'Window defaults to last 24h. Returns aggregated counts, sums, and bucket histograms ' +
      'from telemetry_hourly, plus a per-faculty summary (`buckets`). ' +
      'Zero-call faculties are hidden from the summary unless `verbose: true`.',
    inputSchema: {
      type: 'object',
      properties: {
        faculty: {
          type: 'string',
          description: 'e.g. "intuition", "reinforcement". Optional.',
        },
        event_kind: {
          type: 'string',
          description: 'e.g. "recall", "evaluate". Optional.',
        },
        window: {
          type: 'string',
          description: 'ISO duration: "PT24H", "P7D". Default "PT24H".',
        },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
        verbose: {
          type: 'boolean',
          description:
            'Include zero-call faculties in the per-faculty summary. Default false.',
        },
      },
    },
    handler: async (args = {}) => {
      const cfg = await readTelemetryConfig(db);
      if (cfg.shadow_mode) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  'show_telemetry_rollup is in shadow mode; flip runtime:telemetry.config.shadow_mode to false to enable.',
              }),
            },
          ],
        };
      }
      const sinceMs = Date.now() - parseWindowMs(args.window ?? 'PT24H');
      const since = new Date(sinceMs);
      const faculty = typeof args.faculty === 'string' && args.faculty.length ? args.faculty : null;
      const eventKind =
        typeof args.event_kind === 'string' && args.event_kind.length ? args.event_kind : null;
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 200;
      const wheres = ['hour >= $since'];
      const params = { since, limit };
      if (faculty !== null) {
        wheres.push('faculty = $faculty');
        params.faculty = faculty;
      }
      if (eventKind !== null) {
        wheres.push('event_kind = $event_kind');
        params.event_kind = eventKind;
      }
      const sql = `SELECT * FROM telemetry_hourly
            WHERE ${wheres.join(' AND ')}
            ORDER BY hour DESC, faculty, event_kind
            LIMIT $limit`;
      const [rows] = await db.query(sql, params).collect();
      const verbose = args.verbose === true;
      // Aggregate raw telemetry_hourly rows into per-faculty buckets so the
      // agent gets a stable, summary view alongside the row-level data.
      // metric_sums.latency_ms_sum / count drive avg_latency_ms; metric_sums
      // .errors_sum (when present) drives errors. Cost columns are not
      // currently populated by the rollup-registry — left at zero.
      const accum = new Map();
      for (const r of rows ?? []) {
        const faculty = r.faculty;
        if (typeof faculty !== 'string' || !faculty) continue;
        const entry = accum.get(faculty) ?? {
          calls: 0,
          cost_usd: 0,
          latency_sum_ms: 0,
          errors: 0,
        };
        const count = Number(r.count ?? 0) || 0;
        entry.calls += count;
        const sums = r.metric_sums ?? {};
        if (typeof sums.latency_ms_sum === 'number') entry.latency_sum_ms += sums.latency_ms_sum;
        if (typeof sums.cost_usd_sum === 'number') entry.cost_usd += sums.cost_usd_sum;
        if (typeof sums.errors_sum === 'number') entry.errors += sums.errors_sum;
        accum.set(faculty, entry);
      }
      const bucketInput = {};
      for (const [faculty, e] of accum) {
        bucketInput[faculty] = {
          calls: e.calls,
          cost_usd: e.cost_usd,
          avg_latency_ms: e.calls > 0 ? e.latency_sum_ms / e.calls : null,
          errors: e.errors,
        };
      }
      const buckets = reshapeTelemetryRollup({ buckets: bucketInput, verbose });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { window: args.window ?? 'PT24H', rows: rows ?? [], buckets },
              null,
              2,
            ),
          },
        ],
      };
    },
  };
}
