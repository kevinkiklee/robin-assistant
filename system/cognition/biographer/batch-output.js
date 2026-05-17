// batch-output.js — validates the batched biographer LLM response.
//
// Wraps `validateBiographerOutput` per entry. Returns:
//   { ok: true, events: Map<event_id, validated_entry>, missing: [], malformed: [] }
// for any batch whose outer envelope (`events` is an array) is well-formed.
// A non-array `events` (or non-object outer) is a batch-level failure that
// the caller should treat as the §8 fallback path.

import { validateBiographerOutput } from './output.js';

export function validateBiographerBatchOutput(o, expectedIds) {
  if (!o || typeof o !== 'object') {
    return { ok: false, error: 'output must be an object' };
  }
  if (!Array.isArray(o.events)) {
    return { ok: false, error: 'output.events must be an array' };
  }
  const expected = new Set(expectedIds.map(String));
  const events = new Map();
  const malformed = [];
  for (const entry of o.events) {
    if (!entry || typeof entry !== 'object') {
      malformed.push({ event_id: '<missing event_id>', error: 'entry not an object' });
      continue;
    }
    const id = entry.event_id;
    if (typeof id !== 'string' || id.length === 0) {
      malformed.push({
        event_id: '<missing event_id>',
        error: 'event_id must be non-empty string',
      });
      continue;
    }
    if (!expected.has(id)) {
      // Extra entries the LLM produced for ids we didn't ask about: silently drop.
      continue;
    }
    const v = validateBiographerOutput(entry);
    if (!v.ok) {
      malformed.push({ event_id: id, error: v.error });
      continue;
    }
    // Coercing validator may have surfaced warnings while keeping the event.
    // Roll the count into the result so the caller can decide whether to
    // log; we don't reject otherwise-valid entries because of stray vocab.
    if (v.warnings?.length) {
      entry._biographer_warnings = v.warnings;
    }
    events.set(id, entry);
  }
  const seen = new Set(events.keys());
  for (const m of malformed) seen.add(m.event_id);
  const missing = expectedIds.map(String).filter((id) => !seen.has(id));
  return { ok: true, events, missing, malformed };
}
