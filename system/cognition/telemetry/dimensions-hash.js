// dimensions-hash.js — deterministic ID for telemetry_hourly rows.
//
// Spec §3.5: dimension values are restricted to `string | bool | int`
// (no floats, no nested objects, no arrays, no non-ASCII). Validation is
// enforced upstream by `recordTelemetry()`. The serializer here only
// requires *sorted keys* on the JSON form so the hash is stable.

import { createHash } from 'node:crypto';

/**
 * Deterministic SHA-256 over `<faculty>|<event_kind>|<iso_hour>|<sorted_dims_json>`,
 * truncated to 24 hex chars (~96 bits — collision-safe for ≤10K rows).
 *
 * @param {string} faculty
 * @param {string} event_kind
 * @param {Date}   hour          Top of the hour; the aggregator passes
 *                               `time::floor(ts, 1h)` results.
 * @param {object|null|undefined} dimensions
 * @returns {string}             24-char hex.
 */
export function dimensionsHash(faculty, event_kind, hour, dimensions) {
  const sortedEntries = Object.entries(dimensions ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const sorted = Object.fromEntries(sortedEntries);
  const hourIso = hour instanceof Date ? hour.toISOString() : String(hour);
  const key = `${faculty}|${event_kind}|${hourIso}|${JSON.stringify(sorted)}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}
