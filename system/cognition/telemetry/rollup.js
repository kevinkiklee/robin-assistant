// rollup.js — heartbeat-paced aggregator. Reads cursors, runs registered
// SELECTs against [cursor, cutoff), UPSERTs telemetry_hourly:{dim_hash}
// rows, advances cursors. Idempotent (every tick re-aggregates the
// window). Fail-soft per branch — a malformed SELECT in one entry does
// NOT prevent another entry's cursor from advancing.

import { dimensionsHash } from './dimensions-hash.js';
import { buildRegistry, getEnabledEntries } from './rollup-registry.js';

const DEFAULT_CUTOFF_SAFETY_SECONDS = 60;

async function readCursors(db) {
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`telemetry.cursor`')
      .collect();
    return rows?.[0] ?? {};
  } catch {
    return {};
  }
}

async function writeCursors(db, cursors) {
  // UPSERT replaces the whole `value` object — every cursor key is
  // re-serialized. This is the same idiom as `runtime:cadence.cursors`.
  await db
    .query('UPSERT runtime:`telemetry.cursor` SET value = $value', { value: cursors })
    .collect();
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  return null;
}

async function rollupOne({ db, entry, cfg, cursors, cutoff, results }) {
  const lastCursor = toDate(cursors[entry.cursorName]);
  const cursor = lastCursor
    ? lastCursor
    : new Date(Date.now() - cfg.cursor_fallback_window_hours * 3_600_000);
  try {
    const { sql, params } = entry.select({ cursor, cutoff, cfg });
    const [rows] = await db.query(sql, params).collect();
    let upserts = 0;
    for (const r of rows ?? []) {
      const families = entry.project(r);
      for (const fam of families) {
        const id = dimensionsHash(fam.faculty, fam.event_kind, fam.hour, fam.dimensions);
        const payload = {
          hour: fam.hour,
          faculty: fam.faculty,
          event_kind: fam.event_kind,
          dimensions: fam.dimensions,
          count: fam.count,
          metric_sums: fam.metric_sums,
          metric_buckets: fam.metric_buckets,
        };
        await db
          .query(
            `UPSERT type::record('telemetry_hourly', $id) CONTENT $payload`,
            { id, payload },
          )
          .collect();
        upserts += 1;
      }
    }
    cursors[entry.cursorName] = cutoff;
    results[entry.name] = { ok: true, upserts, rows: (rows ?? []).length };
  } catch (e) {
    results[entry.name] = { ok: false, error: e.message };
    // Per-cursor fail-soft: leave cursors[entry.cursorName] untouched so
    // next tick re-tries the same window.
  }
}

/**
 * Run one rollup tick.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.cfg                   readTelemetryConfig output
 * @param {() => Date} [args.nowFn]           injectable clock for tests
 * @returns {Promise<{cursors_advanced: object, per_entry: object}>}
 */
export async function rollupHotTelemetry({ db, cfg, nowFn }) {
  const now = typeof nowFn === 'function' ? nowFn() : new Date();
  const cutoff = new Date(
    now.getTime() - (cfg.cutoff_safety_seconds ?? DEFAULT_CUTOFF_SAFETY_SECONDS) * 1000,
  );

  const reg = buildRegistry();
  const enabled = getEnabledEntries(reg, cfg);
  const cursors = await readCursors(db);
  const results = {};

  for (const entry of enabled) {
    await rollupOne({ db, entry, cfg, cursors, cutoff, results });
  }

  try {
    await writeCursors(db, cursors);
  } catch (e) {
    results.__cursor_write = { ok: false, error: e.message };
  }

  return { cursors_advanced: cursors, per_entry: results };
}
