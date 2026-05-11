// retention.js — DELETE rows where <timestampField> < $before AND <where?>.
// Single DELETE per call. Caller handles fail-soft.

/**
 * @param {object} args
 * @param {object} args.db
 * @param {string} args.table              e.g. 'intuition_telemetry', 'recall_log', 'telemetry_hourly'
 * @param {Date}   args.before             rows with timestampField < before are deleted
 * @param {string} [args.timestampField]   default 'ts'; 'hour' for telemetry_hourly
 * @param {string} [args.where]            optional extra WHERE clause (raw SurrealQL fragment)
 * @returns {Promise<{ count: number }>}
 */
export async function pruneRawTelemetry({ db, table, before, timestampField = 'ts', where }) {
  const whereExtra = where ? ` AND (${where})` : '';
  // table is a non-bound identifier; the caller MUST pass a hardcoded
  // string. The function is internal-only.
  const sql = `DELETE ${table} WHERE ${timestampField} < $before${whereExtra} RETURN BEFORE`;
  const [result] = await db.query(sql, { before }).collect();
  return { count: Array.isArray(result) ? result.length : 0 };
}
