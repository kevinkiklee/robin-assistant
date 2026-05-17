import { BoundQuery } from 'surrealdb';
import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

export function createGetCalibrationTool({ db }) {
  return {
    name: 'get_calibration',
    description:
      "Read Robin's current decision calibration: confidence bands by statement kind, prediction accuracy, and Brier score history. Optionally filter to a specific statement_kind.",
    inputSchema: {
      type: 'object',
      properties: {
        statement_kind: { type: 'string', minLength: 1, maxLength: 100 },
      },
    },
    handler: async (args) => {
      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };

      const statementKind = args.statement_kind ?? null;

      const filters = ["kind = 'confidence_band'"];
      const bindings = {};
      if (statementKind) {
        filters.push('meta.statement_kind = $sk');
        bindings.sk = statementKind;
      }

      // SurrealDB v3 requires ORDER BY fields to appear in the SELECT list.
      const sql = `
        SELECT meta,
               meta.statement_kind AS statement_kind,
               meta.bucket AS bucket
        FROM memos
        WHERE ${filters.join(' AND ')}
        ORDER BY statement_kind, bucket
      `;

      const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
      const list = Array.isArray(rows) ? rows : rows ? [rows] : [];

      // Group by statement_kind
      const calibration = {};
      for (const r of list) {
        const kind = r.meta?.statement_kind ?? 'unknown';
        if (!calibration[kind]) calibration[kind] = [];
        calibration[kind].push({
          bucket: r.meta?.bucket ?? null,
          n: r.meta?.n ?? 0,
          correct: r.meta?.correct ?? 0,
          accuracy_laplace: r.meta?.accuracy_laplace ?? null,
          raw_accuracy: r.meta?.n > 0 ? (r.meta?.correct ?? 0) / r.meta.n : null,
        });
      }

      return { ok: true, calibration };
    },
  };
}
