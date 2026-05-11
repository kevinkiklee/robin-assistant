// show-telemetry-rollup.js — read-only MCP introspection tool over
// telemetry_hourly. Shadow-mode-aware. Read-only by contract (enforced
// by audit-introspection-readonly.test.js: no SurrealQL write keywords
// permitted in this file).

import { readTelemetryConfig } from '../../../cognition/telemetry/config.js';

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
      'from telemetry_hourly.',
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
        limit: { type: 'number', default: 200 },
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
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { window: args.window ?? 'PT24H', rows: rows ?? [] },
              null,
              2,
            ),
          },
        ],
      };
    },
  };
}
