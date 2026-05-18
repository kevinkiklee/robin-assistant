// Coerce a possibly-stringified record reference back to a RecordId-shaped
// value so it round-trips through a `surql` tagged template as a record
// reference (not a string literal).
//
// Why this exists: SurrealDB v2.0.3's `surql` tag treats a JS string as a
// string parameter — interpolating `'entities:foo'` produces `UPDATE 'entities:foo'
// SET ...`, which the engine rejects with "Cannot execute UPDATE statement
// using value: '...'". RecordId / StringRecordId instances round-trip as
// record references, which is the shape the engine expects.
//
// Most SELECTs return RecordId objects directly, so call sites that pass
// `row.id` through unchanged work fine. The case this helper covers is
// legacy / heterogeneous rows whose id arrives as a bare `table:key` string,
// or any boundary that JSON-stringifies a record id along the way.
//
// Apply at the use site (just before surql interpolation), not at the
// SELECT site — call sites can be confident the shape is right at the
// point of interpolation without having to audit every upstream read.

import { RecordId, StringRecordId } from 'surrealdb';

export function toRecordRef(v) {
  if (v == null) return v;
  if (typeof v === 'string') return new StringRecordId(v);
  if (v instanceof RecordId || v instanceof StringRecordId) return v;
  // Some drivers/branches stash the id under `.id` (typical SELECT row).
  // Recurse once so callers can pass the row instead of row.id by accident.
  if (typeof v.id !== 'undefined') return toRecordRef(v.id);
  return v;
}
